import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-web-scroll-flow";
/**
 * 节点半入口：插件的全部行为在浏览器半（/client）。节点半仅作为
 * loader 条目的合法入口存在，使 client-modules 的 dsh.client 扫描
 * 命中本包并服务其浏览器 bundle。
 * @param _ctx - 主机侧 cordis 上下文（本插件不使用）。
 */
declare function apply(_ctx: Context): void;
//#endregion
export { apply, name };
//# sourceMappingURL=index.d.ts.map