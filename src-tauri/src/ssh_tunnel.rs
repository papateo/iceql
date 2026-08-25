// SSH tunnel support: opens a local TCP listener that forwards every accepted connection
// through an SSH "direct-tcpip" channel to the real database host. `resolve_effective_config`
// is the only entry point the rest of the backend needs — it hands back a `ConnectionConfig`
// with `host`/`port` swapped for the local tunnel endpoint (or the original config, untouched,
// when no tunnel is configured), so `ConnectionPool::connect` and every ad-hoc reconnect it does
// internally stay completely unaware that a tunnel exists.
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::models::{ConnectionConfig, SshTunnelConfig};

struct TunnelHandler;

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    // No host-key pinning UI yet — the same trust-on-connect tradeoff most lightweight
    // DB-client SSH tunnels make (this app doesn't verify DB-side TLS certs either).
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// A live SSH tunnel. Keeping this alive keeps the local port forwarding up; dropping it
/// aborts the accept loop and closes the SSH session (the last `Arc` reference going away).
pub struct SshTunnel {
    pub local_port: u16,
    _session: Arc<client::Handle<TunnelHandler>>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// If `config.ssh_tunnel` is set and enabled, opens the tunnel and returns a config pointing at
/// its local forwarded port (plus the tunnel handle — the caller must keep it alive for as long
/// as the connection is used). Otherwise returns the config unchanged and no tunnel.
pub async fn resolve_effective_config(
    config: &ConnectionConfig,
) -> Result<(ConnectionConfig, Option<SshTunnel>), String> {
    let ssh = match &config.ssh_tunnel {
        Some(ssh) if ssh.enabled => ssh,
        _ => return Ok((config.clone(), None)),
    };
    let tunnel = open_tunnel(ssh, &config.host, config.port).await?;
    let mut effective = config.clone();
    effective.host = "127.0.0.1".to_string();
    effective.port = tunnel.local_port;
    Ok((effective, Some(tunnel)))
}

async fn open_tunnel(
    cfg: &SshTunnelConfig,
    remote_host: &str,
    remote_port: u16,
) -> Result<SshTunnel, String> {
    let ssh_config = Arc::new(client::Config::default());
    let mut session = client::connect(ssh_config, (cfg.host.as_str(), cfg.port), TunnelHandler)
        .await
        .map_err(|e| format!("Could not connect to SSH host {}:{}: {e}", cfg.host, cfg.port))?;

    let authenticated = if cfg.auth_method == "key" {
        let key_path = cfg
            .private_key_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "SSH private key path is required".to_string())?;
        let key_pair = load_secret_key(Path::new(key_path), cfg.passphrase.as_deref())
            .map_err(|e| format!("Could not load SSH private key: {e}"))?;
        let hash_alg = session
            .best_supported_rsa_hash()
            .await
            .map_err(|e| e.to_string())?
            .flatten();
        session
            .authenticate_publickey(
                cfg.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
            )
            .await
            .map_err(|e| format!("SSH authentication failed: {e}"))?
    } else {
        session
            .authenticate_password(cfg.username.clone(), cfg.password.clone().unwrap_or_default())
            .await
            .map_err(|e| format!("SSH authentication failed: {e}"))?
    };
    if !authenticated.success() {
        return Err("SSH server rejected the credentials".to_string());
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Could not open local tunnel port: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let session = Arc::new(session);
    let remote_host = remote_host.to_string();
    let accept_session = session.clone();
    let accept_task = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let session = accept_session.clone();
            let remote_host = remote_host.clone();
            // Any failure here just ends this one forwarded connection — the DB client
            // driver on the other end already surfaces a connection error to the user.
            tokio::spawn(async move {
                let _ = pump(session, stream, peer, remote_host, remote_port).await;
            });
        }
    });

    Ok(SshTunnel {
        local_port,
        _session: session,
        accept_task,
    })
}

/// Shuttles bytes between one locally-accepted TCP connection and its own SSH direct-tcpip
/// channel to the real database host, for as long as either side stays open.
async fn pump(
    session: Arc<client::Handle<TunnelHandler>>,
    mut stream: TcpStream,
    peer: SocketAddr,
    remote_host: String,
    remote_port: u16,
) -> Result<(), russh::Error> {
    let mut channel = session
        .channel_open_direct_tcpip(
            remote_host,
            remote_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await?;
    let mut buf = vec![0u8; 32 * 1024];
    let mut stream_closed = false;
    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => { stream_closed = true; channel.eof().await?; }
                    Ok(n) => channel.data(&buf[..n]).await?,
                    Err(_) => break,
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => { let _ = stream.write_all(data).await; }
                    Some(ChannelMsg::Eof) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
