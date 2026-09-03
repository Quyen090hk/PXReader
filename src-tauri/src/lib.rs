use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            if let Ok(document_dir) = app.path().document_dir() {
                std::fs::create_dir_all(document_dir.join("P5Reader").join("Books"))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running P5Reader");
}
