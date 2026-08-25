// MQTT support. Unlike the SQL/Mongo/Redis paths, MQTT has no schema to browse up front —
// topics are only discovered as messages arrive. So the backend's job here is narrow: connect,
// auto-subscribe to everything (`#`) so the frontend's topic tree populates itself the way
// MQTT Explorer does, and stream every received message up to the frontend as a Tauri event.
// The topic tree and per-topic message history are built and owned entirely on the frontend.
use std::time::Duration;

use base64::Engine;
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::models::ConnectionConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttMessageEvent {
    pub connection_id: String,
    pub topic: String,
    // Base64-encoded — MQTT payloads are arbitrary bytes, not guaranteed UTF-8.
    pub payload_base64: String,
    pub qos: u8,
    pub retain: bool,
    pub timestamp_ms: i64,
}

/// A live MQTT connection. Keeping this alive keeps its background event-loop poll running;
/// dropping it stops that task (the broker then times out the session after its keep-alive).
pub struct MqttConnection {
    pub client: AsyncClient,
    poll_task: tokio::task::JoinHandle<()>,
}

impl Drop for MqttConnection {
    fn drop(&mut self) {
        self.poll_task.abort();
    }
}

pub fn qos_from_u8(qos: u8) -> QoS {
    match qos {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}

fn mqtt_options(config: &ConnectionConfig) -> MqttOptions {
    // `database` is repurposed as the MQTT client id (like Redis repurposes it as a db index) —
    // there's no "database" concept in MQTT, so this avoids adding a dedicated config field.
    let client_id = if config.database.trim().is_empty() {
        format!("iceql-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        config.database.clone()
    };
    let mut opts = MqttOptions::new(client_id, config.host.clone(), config.port);
    opts.set_keep_alive(Duration::from_secs(30));
    if !config.username.is_empty() {
        opts.set_credentials(config.username.clone(), config.password.clone());
    }
    opts
}

/// Connects, auto-subscribes to `#`, and spawns the background task that forwards every
/// incoming publish to the frontend as an `mqtt-message` event tagged with `connection_id`.
pub async fn connect(
    app: AppHandle,
    connection_id: String,
    config: &ConnectionConfig,
) -> Result<MqttConnection, String> {
    let opts = mqtt_options(config);
    let (client, mut eventloop) = AsyncClient::new(opts, 256);

    client
        .subscribe("#", QoS::AtMostOnce)
        .await
        .map_err(|e| format!("MQTT connection failed: {e}"))?;

    let poll_app = app;
    let poll_conn_id = connection_id;
    let poll_task = tokio::spawn(async move {
        loop {
            match eventloop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    let evt = MqttMessageEvent {
                        connection_id: poll_conn_id.clone(),
                        topic: p.topic.clone(),
                        payload_base64: base64::engine::general_purpose::STANDARD.encode(&p.payload),
                        qos: p.qos as u8,
                        retain: p.retain,
                        timestamp_ms: chrono::Utc::now().timestamp_millis(),
                    };
                    let _ = poll_app.emit("mqtt-message", evt);
                }
                Ok(_) => {}
                // The eventloop can't be polled again after an error — end the task. The
                // frontend finds out the connection died the next time it tries to use it.
                Err(_) => break,
            }
        }
    });

    Ok(MqttConnection { client, poll_task })
}

/// A quick connect-and-verify for the "Test Connection" button — waits briefly for the
/// broker's CONNACK, then drops the connection without subscribing to anything.
pub async fn test_connection(config: &ConnectionConfig) -> Result<(), String> {
    let opts = mqtt_options(config);
    let (_client, mut eventloop) = AsyncClient::new(opts, 16);
    let deadline = tokio::time::sleep(Duration::from_secs(8));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return Err("Timed out waiting for the MQTT broker".to_string()),
            event = eventloop.poll() => {
                match event {
                    Ok(Event::Incoming(Incoming::ConnAck(ack))) => {
                        return if ack.code == rumqttc::ConnectReturnCode::Success {
                            Ok(())
                        } else {
                            Err(format!("MQTT broker rejected the connection: {:?}", ack.code))
                        };
                    }
                    Ok(_) => continue,
                    Err(e) => return Err(format!("MQTT connection failed: {e}")),
                }
            }
        }
    }
}
