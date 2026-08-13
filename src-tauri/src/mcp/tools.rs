use crate::proxy::state::AppState;
use rmcp::{
    handler::server::ServerHandler,
    model::{CallToolResult, ContentBlock},
    tool, tool_handler, tool_router,
};

#[derive(Clone)]
pub struct KbMcpServer {
    /// Task 3 将用 `state.repo` 读真实知识库;当前占位工具尚未读取。
    #[allow(dead_code)]
    state: AppState,
}

impl KbMcpServer {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

#[tool_router]
impl KbMcpServer {
    /// 列出所有知识库(占位实现,Task 3 补真实逻辑)
    #[tool(name = "kb_list_bases", description = "列出所有知识库")]
    pub async fn kb_list_bases(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let json = "[]".to_string();
        Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
    }
}

#[tool_handler]
impl ServerHandler for KbMcpServer {}
