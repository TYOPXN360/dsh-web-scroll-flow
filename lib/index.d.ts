import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-web-scroll-flow";
/** 静态声明 settings 服务依赖：cordis 先确保服务 ready 再执行 apply。 */
declare const inject: string[];
/**
 * 节点半入口：注册浏览器设置项的 Host section，使 General 设置行写入的
 * 偏好持久化到用户设置文档。滚动动效本身在浏览器半（/client）。
 * @param ctx - 主机侧 cordis 上下文（settings 服务已就绪）。
 */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };
//# sourceMappingURL=index.d.ts.map