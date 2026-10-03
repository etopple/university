// Worker build stub for satteri (Starlight/Astro markdown engine, a native module).
// Pages render from EmDash at request time; no markdown is compiled in the Worker.
// Any call means a code path we did not expect, so fail loudly.
const no = (n) => () => { throw new Error("satteri." + n + " is not available in the Worker"); };
export class HastReader { constructor() { no("HastReader")(); } }
export class MdastReader { constructor() { no("MdastReader")(); } }
export const applyCommandsAndConvertToHastHandle = no("applyCommandsAndConvertToHastHandle");
export const applyCommandsToMdastHandle = no("applyCommandsToMdastHandle");
export const compileHandle = no("compileHandle");
export const convertMdastToHastHandle = no("convertMdastToHastHandle");
export const createHastHandle = no("createHastHandle");
export const createMdastHandle = no("createMdastHandle");
export const createMdxHastHandle = no("createMdxHastHandle");
export const createMdxMdastHandle = no("createMdxMdastHandle");
export const defineHastPlugin = no("defineHastPlugin");
export const defineMdastPlugin = no("defineMdastPlugin");
export const dropHandle = no("dropHandle");
export const evaluate = no("evaluate");
export const getHandleSource = no("getHandleSource");
export const htmlToHast = no("htmlToHast");
export const markdownToHast = no("markdownToHast");
export const markdownToHtml = no("markdownToHtml");
export const markdownToJs = no("markdownToJs");
export const markdownToMdast = no("markdownToMdast");
export const materializeHastTree = no("materializeHastTree");
export const materializeMdastTree = no("materializeMdastTree");
export const mdxToHast = no("mdxToHast");
export const mdxToJs = no("mdxToJs");
export const mdxToMdast = no("mdxToMdast");
export const normalizePlugins = no("normalizePlugins");
export const renderHandle = no("renderHandle");
export const resolveHastSubscriptions = no("resolveHastSubscriptions");
export const resolveMdastSubscriptions = no("resolveMdastSubscriptions");
export const serializeHandle = no("serializeHandle");
export const visitHastHandle = no("visitHastHandle");
export const visitHastHook = no("visitHastHook");
export const visitMdastHandle = no("visitMdastHandle");
export const visitMdastHook = no("visitMdastHook");
