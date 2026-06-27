// Rush Tauri backend entry. Registers the FS command layer and the project-root
// state, then runs the app. More command modules (terminal, git, package
// managers) will register here as they're built on top of this spine.

mod fs_commands;
mod git_commands;
mod package_commands;

use fs_commands::ProjectRoot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ProjectRoot::default())
        .invoke_handler(tauri::generate_handler![
            fs_commands::set_project_root,
            fs_commands::read_file,
            fs_commands::write_file,
            fs_commands::create_dir,
            fs_commands::delete_file,
            fs_commands::list_dir,
            git_commands::git_status,
            git_commands::git_diff,
            git_commands::git_branch,
            git_commands::git_current_branch,
            git_commands::git_commit,
            git_commands::git_push,
            git_commands::git_pull,
            package_commands::npm_scripts,
            package_commands::npm_run_script,
            package_commands::npm_install,
            package_commands::npm_ci,
            package_commands::cargo_check_cmd,
            package_commands::cargo_test_cmd,
            package_commands::cargo_build_cmd,
            package_commands::pip_install,
            package_commands::winget_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rush");
}
