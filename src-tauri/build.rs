fn main() {
    // generate_context!() embeds ../dist at compile time. Without this, Cargo can
    // reuse a previous expansion that had no frontend files.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
