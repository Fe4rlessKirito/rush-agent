use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_PACK_FILES: usize = 500;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct PackSourceFile {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct PackFolderScan {
    pub root: String,
    pub files: Vec<PackSourceFile>,
    pub skipped_count: usize,
    pub warnings: Vec<String>,
}

fn rel_string(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('\\', "/")
}

fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".svn" | ".hg" | "node_modules" | "target" | "dist" | "build" | "__pycache__"
    )
}

fn is_pack_candidate(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    (lower.starts_with("skills/") && lower.ends_with("/skill.md"))
        || (lower.starts_with("commands/") && lower.ends_with(".md"))
        || (lower.starts_with("rules/") && lower.ends_with(".md"))
        || (lower.starts_with("manifests/") && lower.ends_with(".json"))
}

fn sorted_children(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| format!("list {}: {e}", path.display()))? {
        out.push(entry.map_err(|e| format!("entry: {e}"))?.path());
    }
    out.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    Ok(out)
}

fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

#[tauri::command]
pub fn scan_pack_folder(path: String) -> Result<PackFolderScan, String> {
    let input = PathBuf::from(path.trim());
    if input.as_os_str().is_empty() {
        return Err("pack folder path is empty".into());
    }
    if has_parent_component(&input) {
        return Err("pack folder path may not contain parent-directory components".into());
    }
    if !input.is_dir() {
        return Err(format!("not a directory: {}", input.display()));
    }

    let root = input
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", input.display()))?;
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_count = 0usize;
    let mut total_bytes = 0u64;
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        for child in sorted_children(&dir)? {
            if files.len() >= MAX_PACK_FILES {
                skipped_count += 1;
                continue;
            }

            let meta = match fs::metadata(&child) {
                Ok(meta) => meta,
                Err(err) => {
                    skipped_count += 1;
                    warnings.push(format!("Could not inspect {}: {err}", child.display()));
                    continue;
                }
            };

            if meta.is_dir() {
                if should_skip_dir(&child) {
                    skipped_count += 1;
                } else {
                    stack.push(child);
                }
                continue;
            }

            if !meta.is_file() {
                skipped_count += 1;
                continue;
            }

            let rel = rel_string(&root, &child);
            if !is_pack_candidate(&rel) {
                skipped_count += 1;
                continue;
            }

            if meta.len() > MAX_FILE_BYTES {
                skipped_count += 1;
                warnings.push(format!(
                    "Skipped {rel}: file is larger than {MAX_FILE_BYTES} bytes"
                ));
                continue;
            }
            if total_bytes + meta.len() > MAX_TOTAL_BYTES {
                skipped_count += 1;
                warnings.push(format!(
                    "Skipped {rel}: pack scan exceeded {MAX_TOTAL_BYTES} bytes"
                ));
                continue;
            }

            match fs::read_to_string(&child) {
                Ok(content) => {
                    total_bytes += meta.len();
                    files.push(PackSourceFile { path: rel, content });
                }
                Err(err) => {
                    skipped_count += 1;
                    warnings.push(format!("Could not read {rel}: {err}"));
                }
            }
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(PackFolderScan {
        root: root.to_string_lossy().into_owned(),
        files,
        skipped_count,
        warnings,
    })
}
