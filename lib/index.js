import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
//#region src/settings.ts
/**
* 滚动动效设置的 Host 侧声明：namespace 与 schemastery schema。
* Host 注册该 section 后，浏览器侧的 settingsScope 写入才会持久化。
*/
const SCROLL_FLOW_SETTINGS_NAMESPACE = "dsh-web-scroll-flow";
const FOLLOW_MODE_FIELD = "followMode";
const BOUNCE_ENABLED_FIELD = "bounceEnabled";
const TYPEWRITER_ENABLED_FIELD = "typewriterEnabled";
const FOLLOW_MODES = [
	"off",
	"gentle",
	"medium"
];
const DEFAULT_FOLLOW_MODE = "medium";
/** Host 持久化 schema；浏览器 settingsScope 也会用它校验 wire section。 */
const ScrollFlowSettingsSchema = z.object({
	[FOLLOW_MODE_FIELD]: z.union([...FOLLOW_MODES]).default(DEFAULT_FOLLOW_MODE),
	[BOUNCE_ENABLED_FIELD]: z.boolean().default(true),
	[TYPEWRITER_ENABLED_FIELD]: z.boolean().default(true)
});
//#endregion
//#region src/index.ts
const name = "dsh-web-scroll-flow";
/**
* 节点半入口：注册浏览器设置项的 Host section，使 General 设置行写入的
* 偏好持久化到用户设置文档。滚动动效本身在浏览器半（/client）。
* @param ctx - 主机侧 cordis 上下文。
*/
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(settingsNamespace(SCROLL_FLOW_SETTINGS_NAMESPACE), ScrollFlowSettingsSchema);
	});
}
//#endregion
export { apply, name };

//# sourceMappingURL=index.js.map