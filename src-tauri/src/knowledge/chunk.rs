//! 知识库文档分块纯函数模块。
//!
//! 后续 `ingest` 任务会调用此处能力把原始文本/代码切分为 `Chunk`。
//! 当前 `chunk_code` 仅按纯文本递归策略降级实现，Task 3 再接入 tree-sitter
//! 做按符号切分。

const DEFAULT_OVERLAP_TOKENS: i64 = 50;
const CHARS_PER_TOKEN: i64 = 4;

/// 文件类型：决定后续使用文本还是代码分块策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Markdown,
    Text,
    Code,
}

/// 单个分块结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub seq: i64,
    pub symbol: Option<String>,
    pub content: String,
    pub token_count: i64,
}

/// 根据扩展名识别文件类型。
pub fn detect_file_type(filename: &str) -> FileType {
    let lower = filename.to_lowercase();
    if lower.ends_with(".md") {
        return FileType::Markdown;
    }
    const CODE_EXTS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".c", ".cpp", ".h",
        ".rb", ".sh",
    ];
    if CODE_EXTS.iter().any(|ext| lower.ends_with(ext)) {
        return FileType::Code;
    }
    FileType::Text
}

/// 按字符数估算 token 数：每 4 个字符 1 个 token，至少 1。
pub fn estimate_tokens(s: &str) -> i64 {
    (s.chars().count() as i64 / CHARS_PER_TOKEN).max(1)
}

/// 对 Markdown / 纯文本做递归降级分块。
///
/// 切分策略（按优先级）：
/// 1. Markdown 标题边界 `\n##` / `\n#`；
/// 2. 空行段落边界；
/// 3. 单换行边界；
/// 4. 硬切到目标字符长度。
///
/// 相邻块之间会把前一块尾部 `overlap_tokens * 4` 个字符重叠到后一块头部，
/// 保证语义连续性。
pub fn chunk_text(content: &str, target_tokens: i64, overlap_tokens: i64) -> Vec<Chunk> {
    if content.is_empty() {
        return Vec::new();
    }
    let target_chars = (target_tokens * CHARS_PER_TOKEN).max(CHARS_PER_TOKEN) as usize;
    let overlap_chars = (overlap_tokens * CHARS_PER_TOKEN).max(0) as usize;
    // 为重叠预留空间：除第一块外，后续块会追加前一块尾部 overlap 字符，
    // 因此基础切片按 target - overlap 控制，保证最终每块不超过 target。
    let effective_target = target_chars.saturating_sub(overlap_chars).max(1);

    let pieces = split_to_target(content, effective_target);
    let contents = apply_overlap(pieces, overlap_chars);
    make_chunks(contents)
}

/// 代码分块占位实现：当前直接复用 `chunk_text`，symbol 固定为 `None`。
/// Task 3 将用 tree-sitter 按函数/类等符号切分并回填 symbol。
pub fn chunk_code(content: &str, filename: &str, target_tokens: i64) -> Vec<Chunk> {
    let _ = filename;
    chunk_text(content, target_tokens, DEFAULT_OVERLAP_TOKENS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SplitStrategy {
    Heading,
    Paragraph,
    Line,
    Hard,
}

impl SplitStrategy {
    fn next(self) -> Self {
        match self {
            SplitStrategy::Heading => SplitStrategy::Paragraph,
            SplitStrategy::Paragraph => SplitStrategy::Line,
            SplitStrategy::Line | SplitStrategy::Hard => SplitStrategy::Hard,
        }
    }
}

fn split_to_target(text: &str, target: usize) -> Vec<&str> {
    if text.chars().count() <= target {
        return vec![text];
    }
    split_with_strategy(text, target, SplitStrategy::Heading)
}

fn split_with_strategy<'a>(text: &'a str, target: usize, strategy: SplitStrategy) -> Vec<&'a str> {
    let mut pieces = match strategy {
        SplitStrategy::Heading => split_headings(text),
        SplitStrategy::Paragraph => split_paragraphs(text),
        SplitStrategy::Line => split_lines(text),
        SplitStrategy::Hard => hard_split(text, target),
    };

    if pieces.is_empty() && !text.is_empty() {
        pieces.push(text);
    }

    if strategy == SplitStrategy::Hard {
        return pieces;
    }

    let next = strategy.next();
    let mut result = Vec::new();
    for piece in pieces {
        if piece.chars().count() <= target {
            result.push(piece);
        } else {
            result.extend(split_with_strategy(piece, target, next));
        }
    }
    result
}

/// 按 Markdown 标题边界切分：遇到 `\n#` 即视为新块起点，
/// 换行符归属前一块，避免后续按行切分时产生空行碎片。
fn split_headings(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 == '\n' && i + 1 < chars.len() && chars[i + 1].1 == '#' {
            // 把换行符切到前一块末尾
            let end = chars[i].0 + chars[i].1.len_utf8();
            if start < end {
                pieces.push(&text[start..end]);
            }
            start = end;
            // 跳过当前标题行，避免在同一块内再次按标题切分
            i += 1;
            while i < chars.len() && chars[i].1 != '\n' {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// 按空行段落切分：两个及以上连续换行视为段落边界。
fn split_paragraphs(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 == '\n' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].1 == '\n' {
                j += 1;
            }
            if j > i + 1 {
                // 发现空行
                if start < chars[i].0 {
                    pieces.push(&text[start..chars[i].0]);
                }
                start = if j < chars.len() { chars[j].0 } else { text.len() };
                i = j;
                continue;
            }
        }
        i += 1;
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// 按单换行切分，保留每行尾部的换行符。
fn split_lines(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    for (pos, ch) in text.char_indices() {
        if ch == '\n' {
            let end = pos + ch.len_utf8();
            pieces.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// 硬切：每 `target` 个字符一切，切点在字符边界上。
fn hard_split(text: &str, target: usize) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut iter = text.char_indices().peekable();
    let mut start = 0;
    let mut count = 0;
    while let Some((_pos, _ch)) = iter.next() {
        count += 1;
        if count == target {
            let end = if let Some(&(next_pos, _)) = iter.peek() {
                next_pos
            } else {
                text.len()
            };
            pieces.push(&text[start..end]);
            start = end;
            count = 0;
        }
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

/// 将前一块尾部 `overlap` 个字符重叠到后一块头部。
fn apply_overlap(pieces: Vec<&str>, overlap: usize) -> Vec<String> {
    let mut contents: Vec<String> = Vec::new();
    for piece in pieces {
        let mut content = String::new();
        if let Some(prev) = contents.last() {
            content.push_str(take_tail_chars(prev, overlap));
        }
        content.push_str(piece);
        contents.push(content);
    }
    contents
}

/// 取字符串最后 n 个字符（按 chars 计数），避免 UTF-8 切分 panic。
fn take_tail_chars(s: &str, n: usize) -> &str {
    if n == 0 || s.is_empty() {
        return "";
    }
    let char_count = s.chars().count();
    if char_count <= n {
        return s;
    }
    let skip = char_count - n;
    for (idx, (byte_pos, _)) in s.char_indices().enumerate() {
        if idx == skip {
            return &s[byte_pos..];
        }
    }
    ""
}

fn make_chunks(contents: Vec<String>) -> Vec<Chunk> {
    contents
        .into_iter()
        .enumerate()
        .map(|(i, content)| Chunk {
            seq: i as i64,
            symbol: None,
            token_count: estimate_tokens(&content),
            content,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_file_type_maps_extensions() {
        assert!(matches!(detect_file_type("a.md"), FileType::Markdown));
        assert!(matches!(detect_file_type("b.rs"), FileType::Code));
        assert!(matches!(detect_file_type("c.txt"), FileType::Text));
    }

    #[test]
    fn estimate_tokens_quarter_chars() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens(&"a".repeat(400)), 100);
    }

    #[test]
    fn chunk_text_splits_on_headings() {
        let mut content = String::new();
        for i in 0..3 {
            content.push_str(&format!("## Heading {}\n", i));
            content.push_str(&"word ".repeat(20));
            content.push('\n');
        }
        let chunks = chunk_text(&content, 50, 10);
        assert_eq!(chunks.len(), 3, "应按 ## 标题切成 3 块");
        assert!(chunks[0].content.contains("Heading 0"));
        assert!(chunks[1].content.contains("Heading 1"));
        assert!(chunks[2].content.contains("Heading 2"));
    }

    #[test]
    fn chunk_text_respects_target_and_overlap() {
        let content = "word ".repeat(500); // 约 2500 字符 / 625 token
        let chunks = chunk_text(&content, 50, 10);
        assert!(chunks.len() > 1, "长文无标题应产生多块");
        for (i, c) in chunks.iter().enumerate() {
            assert!(
                c.token_count <= 50,
                "第 {} 块 token 数 {} 超过目标 50",
                i,
                c.token_count
            );
        }
        let overlap_chars = 10 * 4;
        for i in 1..chunks.len() {
            let prev_tail = take_tail_chars(&chunks[i - 1].content, overlap_chars);
            assert!(
                chunks[i].content.starts_with(prev_tail),
                "第 {} 块缺少尾部重叠",
                i
            );
        }
    }

    #[test]
    fn chunk_text_short_content_single_chunk() {
        let chunks = chunk_text("short text", 50, 10);
        assert_eq!(chunks.len(), 1, "短文应只有 1 块");
        assert_eq!(chunks[0].content, "short text");
        assert_eq!(chunks[0].seq, 0);
        assert!(chunks[0].symbol.is_none());
    }

    #[test]
    fn chunk_code_delegates_to_text_with_symbol_none() {
        let chunks = chunk_code("fn main() {}\nfn helper() {}", "main.rs", 50);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.symbol.is_none()));
    }
}
