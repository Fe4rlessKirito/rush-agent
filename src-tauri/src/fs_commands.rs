// Real filesystem command layer, exposed to the frontend via Tauri `invoke`.
//
// Every path the frontend sends is RELATIVE to a chosen project root. We resolve
// it against the root and then verify the resolved path is still inside the
// root before touching disk — this is the path-traversal guard. The agent (and
// any compromised model output driving it) can never read or write outside the
// project directory, even with inputs like "../../etc/passwd".

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use tauri::State;

// The active project root. None until the frontend opens a project folder.
#[derive(Default)]
pub struct ProjectRoot(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String, // relative to the project root, forward-slashed
    pub is_dir: bool,
}

// Normalize a relative path WITHOUT touching the filesystem, rejecting any
// component that would climb above the root (`..`) or anchor to an absolute
// location. Returns a clean relative PathBuf or an error string.
fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => clean.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("path escapes project root: {rel}"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("absolute paths are not allowed: {rel}"));
            }
        }
    }
    Ok(clean)
}

// Resolve a frontend-supplied relative path against the active project root,
// enforcing the traversal guard. Returns the absolute on-disk path.
fn resolve(state: &State<ProjectRoot>, rel: &str) -> Result<PathBuf, String> {
    let guard = state.0.lock().map_err(|_| "root lock poisoned")?;
    let root = guard
        .as_ref()
        .ok_or("no project is open")?
        .clone();
    let clean = safe_relative(rel)?;
    let full = root.join(&clean);

    // Defense in depth: canonicalize the parent and confirm it stays under the
    // canonicalized root, catching symlink-based escapes the textual check misses.
    if let Ok(canon_root) = root.canonicalize() {
        // Only check existing ancestors; a not-yet-created file has no canonical form.
        let check = if full.exists() { full.as_path() } else { full.parent().unwrap_or(&full) };
        if let Ok(canon) = check.canonicalize() {
            if !canon.starts_with(&canon_root) {
                return Err(format!("resolved path escapes project root: {rel}"));
            }
        }
    }
    Ok(full)
}

fn to_rel_string(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('\\', "/")
}

#[tauri::command]
pub fn set_project_root(state: State<ProjectRoot>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut guard = state.0.lock().map_err(|_| "root lock poisoned")?;
    *guard = Some(p);
    Ok(())
}

#[tauri::command]
pub fn read_file(state: State<ProjectRoot>, path: String) -> Result<String, String> {
    let full = resolve(&state, &path)?;
    fs::read_to_string(&full).map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
pub fn write_file(state: State<ProjectRoot>, path: String, content: String) -> Result<(), String> {
    let full = resolve(&state, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir for {path}: {e}"))?;
    }
    fs::write(&full, content).map_err(|e| format!("write {path}: {e}"))
}

#[tauri::command]
pub fn create_dir(state: State<ProjectRoot>, path: String) -> Result<(), String> {
    let full = resolve(&state, &path)?;
    fs::create_dir_all(&full).map_err(|e| format!("mkdir {path}: {e}"))
}

#[tauri::command]
pub fn delete_file(state: State<ProjectRoot>, path: String) -> Result<(), String> {
    let full = resolve(&state, &path)?;
    if full.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| format!("rmdir {path}: {e}"))
    } else {
        fs::remove_file(&full).map_err(|e| format!("rm {path}: {e}"))
    }
}

// List one directory level (non-recursive). `path` is relative; "" lists the root.
#[tauri::command]
pub fn list_dir(state: State<ProjectRoot>, path: String) -> Result<Vec<DirEntry>, String> {
    let full = resolve(&state, if path.is_empty() { "." } else { &path })?;
    let guard = state.0.lock().map_err(|_| "root lock poisoned")?;
    let root = guard.as_ref().ok_or("no project is open")?.clone();
    drop(guard);

    let mut entries = Vec::new();
    for entry in fs::read_dir(&full).map_err(|e| format!("list {path}: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let meta = entry.metadata().map_err(|e| format!("meta: {e}"))?;
        let p = entry.path();
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: to_rel_string(&root, &p),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| (b.is_dir, &a.name).cmp(&(a.is_dir, &b.name)));
    Ok(entries)
}
