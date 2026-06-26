// Rush Tauri backend entry. Registers the FS command layer and the project-root
// state, then runs the app. More command modules (terminal, git, package
// managers) will register here as they're built on top of this spine.

mod fs_commands;

use fs_commands::ProjectRoot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProjectRoot::default())
        .invoke_handler(tauri::generate_handler![
            fs_commands::set_project_root,
            fs_commands::read_file,
            fs_commands::write_file,
            fs_commands::create_dir,
            fs_commands::delete_file,
            fs_commands::list_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rush");
}
