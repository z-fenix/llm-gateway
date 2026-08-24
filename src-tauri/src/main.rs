// 发布版(Windows)隐藏控制台窗口；debug 保留以便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    llm_gateway_lib::run()
}
