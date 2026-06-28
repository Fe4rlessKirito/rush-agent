// Rush Tauri backend entry. Registers the FS command layer and the project-root
// state, then runs the app. More command modules (terminal, git, package
// managers) will register here as they're built on top of this spine.

mod background_commands;
mod code_commands;
mod fs_commands;
mod git_commands;
mod lsp_commands;
mod local_proxy_commands;
mod mcp_commands;
mod package_commands;
mod terminal_commands;
mod worktree_commands;

use background_commands::BackgroundState;
use fs_commands::ProjectRoot;
use mcp_commands::McpSessionState;
use terminal_commands::TerminalState;
use worktree_commands::WorktreeState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectRoot::default())
        .manage(TerminalState::default())
        .manage(BackgroundState::default())
        .manage(WorktreeState::default())
        .manage(McpSessionState::default())
        .manage(lsp_commands::LspState::default())
        .manage(local_proxy_commands::LocalProxyState::default())
        .setup(|app| {
            local_proxy_commands::start_local_proxy(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_commands::set_project_root,
            fs_commands::read_file,
            fs_commands::write_file,
            fs_commands::create_dir,
            fs_commands::delete_file,
            fs_commands::list_dir,
            code_commands::code_find_symbol,
            code_commands::code_find_definition,
            code_commands::code_rename_identifier,
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
            terminal_commands::terminal_start,
            terminal_commands::terminal_write,
            terminal_commands::terminal_send_line,
            terminal_commands::terminal_read,
            terminal_commands::terminal_wait_for_output,
            terminal_commands::terminal_interrupt,
            terminal_commands::terminal_stop,
            background_commands::background_start,
            background_commands::background_read,
            background_commands::background_list,
            background_commands::background_stop,
            worktree_commands::enter_worktree,
            worktree_commands::exit_worktree,
            mcp_commands::mcp_probe_stdio,
            mcp_commands::mcp_call_tool_stdio,
            mcp_commands::mcp_start_stdio_session,
            mcp_commands::mcp_call_tool_session,
            mcp_commands::mcp_stop_session,
            local_proxy_commands::local_proxy_status,
            local_proxy_commands::local_proxy_restart,
            lsp_commands::lsp_probe,
            lsp_commands::lsp_start,
            lsp_commands::lsp_definition,
            lsp_commands::lsp_references,
            lsp_commands::lsp_rename,
            lsp_commands::lsp_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rush");
}
