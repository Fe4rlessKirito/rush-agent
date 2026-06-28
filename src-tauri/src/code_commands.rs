use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::fs_commands::ProjectRoot;

const CODE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "cs", "cpp", "c", "h", "hpp",
    "css", "html", "json", "md",
];

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
];

#[derive(Serialize)]
pub struct CodeMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub text: String,
}

#[derive(Serialize)]
pub struct RenameResult {
    pub files_changed: usize,
    pub replacements: usize,
    pub files: Vec<String>,
}

fn project_root(state: &State<ProjectRoot>) -> Result<PathBuf, String> {
    let guard = state.0.lock().map_err(|_| "root lock poisoned")?;
    if let Some(root) = guard.as_ref() {
        return Ok(root.clone());
    }
    std::env::current_dir().map_err(|e| format!("current_dir: {e}"))
}

fn to_rel_string(root: &Path, full: &Path) -> String {
    full.strip_prefix(root)
        .unwrap_or(full)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_code_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| CODE_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
}

fn should_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| SKIP_DIRS.contains(&name))
        .unwrap_or(false)
}

fn collect_code_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if should_skip_dir(dir) {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|e| format!("list {}: {e}", to_rel_string(root, dir)))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let meta = entry.metadata().map_err(|e| format!("meta: {e}"))?;
        if meta.is_dir() {
            collect_code_files(root, &path, out)?;
        } else if meta.is_file() && is_code_file(&path) {
            out.push(path);
        }
    }
    Ok(())
}

fn is_ident_char(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_ascii_alphabetic()) && chars.all(is_ident_char)
}

fn find_word_positions(line: &str, symbol: &str) -> Vec<usize> {
    let mut positions = Vec::new();
    let mut search_from = 0;
    while let Some(offset) = line[search_from..].find(symbol) {
        let idx = search_from + offset;
        let before = line[..idx].chars().next_back();
        let after = line[idx + symbol.len()..].chars().next();
        if before.map(|ch| !is_ident_char(ch)).unwrap_or(true)
            && after.map(|ch| !is_ident_char(ch)).unwrap_or(true)
        {
            positions.push(idx);
        }
        search_from = idx + symbol.len();
    }
    positions
}

fn likely_definition(line: &str, symbol: &str) -> bool {
    let trimmed = line.trim_start();
    let Some(symbol_idx) = find_word_positions(trimmed, symbol).first().copied() else {
        return false;
    };
    let before = trimmed[..symbol_idx].trim_end();
    let after = trimmed[symbol_idx + symbol.len()..].trim_start();
    let before_tokens: Vec<&str> = before.split_whitespace().collect();
    let prev = before_tokens.last().copied().unwrap_or("");
    let method_like = (after.starts_with('(') || after.starts_with('<'))
        && (after.contains('{')
            || after.contains("=>")
            || (after.contains(':') && after.ends_with(';')));

    matches!(
        prev,
        "function"
            | "class"
            | "interface"
            | "type"
            | "const"
            | "let"
            | "var"
            | "def"
            | "struct"
            | "enum"
            | "fn"
            | "trait"
            | "impl"
    ) || (before_tokens.ends_with(&["async", "function"])
        || before_tokens.ends_with(&["export", "function"])
        || before_tokens.ends_with(&["export", "async", "function"])
        || before_tokens.ends_with(&["export", "default", "function"])
        || before_tokens.ends_with(&["export", "class"])
        || before_tokens.ends_with(&["export", "default", "class"])
        || before_tokens.ends_with(&["export", "interface"])
        || before_tokens.ends_with(&["export", "type"])
        || before_tokens.ends_with(&["export", "const"])
        || before_tokens.ends_with(&["export", "let"])
        || before_tokens.ends_with(&["export", "var"])
        || before_tokens.ends_with(&["pub", "fn"])
        || before_tokens.ends_with(&["pub(crate)", "fn"])
        || before_tokens.ends_with(&["pub", "struct"])
        || before_tokens.ends_with(&["pub", "enum"])
        || before_tokens.ends_with(&["async", "def"]))
        || (before.is_empty() && method_like)
        || (matches!(
            prev,
            "static" | "public" | "private" | "protected" | "override"
        ) && method_like)
}

fn find_matches(
    root: &Path,
    symbol: &str,
    definitions_only: bool,
    limit: usize,
) -> Result<Vec<CodeMatch>, String> {
    if !is_identifier(symbol) {
        return Err(format!("invalid identifier: {symbol}"));
    }

    let mut files = Vec::new();
    collect_code_files(root, root, &mut files)?;
    files.sort();

    let mut matches = Vec::new();
    for file in files {
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        for (line_idx, line) in content.lines().enumerate() {
            if definitions_only && !likely_definition(line, symbol) {
                continue;
            }
            for idx in find_word_positions(line, symbol) {
                matches.push(CodeMatch {
                    path: to_rel_string(root, &file),
                    line: line_idx + 1,
                    column: idx + 1,
                    text: line.trim().to_string(),
                });
                if matches.len() >= limit {
                    return Ok(matches);
                }
            }
        }
    }
    Ok(matches)
}

fn replace_identifier(content: &str, old_name: &str, new_name: &str) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut count = 0;
    for line in content.lines() {
        let mut cursor = 0;
        for idx in find_word_positions(line, old_name) {
            out.push_str(&line[cursor..idx]);
            out.push_str(new_name);
            cursor = idx + old_name.len();
            count += 1;
        }
        out.push_str(&line[cursor..]);
        out.push('\n');
    }
    if !content.ends_with('\n') {
        out.pop();
    }
    (out, count)
}

#[tauri::command]
pub fn code_find_symbol(
    state: State<ProjectRoot>,
    symbol: String,
    limit: Option<usize>,
) -> Result<Vec<CodeMatch>, String> {
    let root = project_root(&state)?;
    find_matches(&root, symbol.trim(), false, limit.unwrap_or(100).min(1000))
}

#[tauri::command]
pub fn code_find_definition(
    state: State<ProjectRoot>,
    symbol: String,
    limit: Option<usize>,
) -> Result<Vec<CodeMatch>, String> {
    let root = project_root(&state)?;
    find_matches(&root, symbol.trim(), true, limit.unwrap_or(50).min(500))
}

#[tauri::command]
pub fn code_rename_identifier(
    state: State<ProjectRoot>,
    old_name: String,
    new_name: String,
    dry_run: bool,
) -> Result<RenameResult, String> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if !is_identifier(old_name) {
        return Err(format!("invalid old identifier: {old_name}"));
    }
    if !is_identifier(new_name) {
        return Err(format!("invalid new identifier: {new_name}"));
    }

    let root = project_root(&state)?;
    let mut files = Vec::new();
    collect_code_files(&root, &root, &mut files)?;
    files.sort();

    let mut changed = Vec::new();
    let mut replacements = 0;
    for file in files {
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        let (next, count) = replace_identifier(&content, old_name, new_name);
        if count == 0 {
            continue;
        }
        replacements += count;
        changed.push(to_rel_string(&root, &file));
        if !dry_run {
            fs::write(&file, next)
                .map_err(|e| format!("write {}: {e}", to_rel_string(&root, &file)))?;
        }
    }

    Ok(RenameResult {
        files_changed: changed.len(),
        replacements,
        files: changed,
    })
}

#[cfg(test)]
mod tests {
    use super::{find_word_positions, is_identifier, likely_definition, replace_identifier};

    #[test]
    fn likely_definition_handles_common_ts_forms() {
        assert!(likely_definition(
            "export async function loadUser(id: string) {",
            "loadUser"
        ));
        assert!(likely_definition(
            "export const useThing = () => {",
            "useThing"
        ));
        assert!(likely_definition("class Widget {", "Widget"));
        assert!(likely_definition("  render(props) {", "render"));
        assert!(likely_definition("  private hydrate<T>() {", "hydrate"));
    }

    #[test]
    fn likely_definition_handles_python_and_rust_forms() {
        assert!(likely_definition("async def fetch_user(id):", "fetch_user"));
        assert!(likely_definition(
            "pub(crate) fn parse_item(input: &str) -> Item {",
            "parse_item"
        ));
        assert!(likely_definition("pub struct ProjectRoot {", "ProjectRoot"));
        assert!(likely_definition("trait Runner {", "Runner"));
    }

    #[test]
    fn likely_definition_rejects_plain_references() {
        assert!(!likely_definition(
            "const value = loadUser(id);",
            "loadUser"
        ));
        assert!(!likely_definition(
            "import { loadUser } from './users';",
            "loadUser"
        ));
        assert!(!likely_definition("object.loadUser();", "loadUser"));
        assert!(!likely_definition("loadUser();", "loadUser"));
    }

    #[test]
    fn word_positions_match_whole_identifiers_only() {
        assert_eq!(
            find_word_positions("foo fooBar _foo foo", "foo"),
            vec![0, 16]
        );
    }

    #[test]
    fn rename_uses_identifier_boundaries() {
        let (next, count) = replace_identifier("foo fooBar\nfoo", "foo", "bar");
        assert_eq!(next, "bar fooBar\nbar");
        assert_eq!(count, 2);
    }

    #[test]
    fn identifier_validation_allows_supported_identifier_chars() {
        assert!(is_identifier("$value_1"));
        assert!(!is_identifier("1value"));
        assert!(!is_identifier("value-name"));
    }
}
