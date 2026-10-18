// Vite 的 ?raw 导入声明：把任意文件源码读成字符串（用于源码级守卫测试）
declare module "*?raw" {
  const content: string;
  export default content;
}
