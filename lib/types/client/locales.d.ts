/** `scrollFlow` namespace dictionaries. */
/** Dictionary namespace owned by this plugin. */
export declare const NS = "scrollFlow";
/** Simplified Chinese dictionary (the key-set source of truth). */
export declare const zh: {
    readonly 'section.nav': "滚动动画";
    readonly 'settings.title': "流式滚动动画";
    readonly 'settings.description': "模型输出时自动跟随最新内容，滚动平滑过渡（含未展开的思考摘要）";
    readonly 'settings.debugTitle': "调试日志";
    readonly 'settings.debugDescription': "记录插件事件与帧率（约 2 万条环形上限，经 window.__DSH_SCROLL_FLOW_DEBUG__ 查看）";
};
/** English dictionary, key-identical to the Chinese source of truth. */
export declare const en: Record<ScrollFlowKey, string>;
/** Key domain of the `scrollFlow` namespace (zh is the source of truth). */
export type ScrollFlowKey = keyof typeof zh;
//# sourceMappingURL=locales.d.ts.map