import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, h, nextTick, reactive } from "vue";

// Exercise the real SFC and answer renderer, replacing only UI button primitives.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("chat-test:")) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "@nyz-rag/ui/components/button" || specifier === "./IconButton.vue") {
      return { url: `chat-test:${specifier === "./IconButton.vue" ? "icon" : "button"}`, shortCircuit: true };
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith("chat-test:")) {
      const source = `import { h } from 'vue';
        const Button = { props: ['label'], setup(props, { attrs, slots }) {
          return () => h('button', { ...attrs, 'aria-label': props.label }, slots.default?.());
        } }; export { Button }; export default Button;`;
      return { format: "module", source, shortCircuit: true };
    }
    if (!url.endsWith(".vue")) return nextLoad(url, context);
    const { descriptor } = parse(readFileSync(fileURLToPath(url), "utf8"));
    const script = compileScript(descriptor, { id: url, inlineTemplate: true });
    const { outputText } = ts.transpileModule(script.content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.cancelAnimationFrame = () => {};
const { default: ChatTurn } = await import("../src/components/ChatTurn.vue");
const node = (type, text = "") => ({ type, text, props: {}, children: [], parent: null });
const renderer = createRenderer({
  createElement: (type) => node(type),
  createText: (text) => node("#text", text),
  createComment: (text) => node("#comment", text),
  setText: (element, text) => { element.text = text; },
  setElementText(element, text) { element.children = []; element.text = text; },
  patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  insert(element, parent, anchor = null) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, element);
    element.parent = parent;
  },
  remove(element) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = null;
  },
  parentNode: (element) => element.parent,
  nextSibling: (element) => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
});
const all = (root, type) => [...(root.type === type ? [root] : []), ...root.children.flatMap((child) => all(child, type))];
const text = (root) => root.type === "#comment" ? "" : root.text + root.children.map(text).join("");
function mount(t, overrides = {}) {
  const events = [];
  const props = reactive({
    turn: {
      id: "message-1", question: "Question", answer: "Answer [1]", answerMode: "generated", rating: null,
      sources: [{ documentId: "doc-1", title: "Article", url: "https://example.test" }],
    },
    isLast: true, busy: false, activeCitation: 1,
    onCopy: () => events.push(["copy"]), onRetry: () => events.push(["retry"]),
    onFeedback: (...args) => events.push(["feedback", ...args]), onSource: (citation) => events.push(["source", citation]),
    ...overrides,
  });
  const root = node("root");
  const app = renderer.createApp({ render: () => h(ChatTurn, props) });
  app.mount(root);
  t.after(() => app.unmount());
  return { root, props, events, button: (label) => all(root, "button").find((item) => text(item).trim() === label || item.props["aria-label"] === label) };
}

test("turn actions emit to the page without mutating their input", (t) => {
  const view = mount(t);
  const previous = JSON.stringify(view.props.turn);
  for (const label of ["复制", "重新生成", "有帮助", "需要改进", "查看原文片段", "1Article", "1"]) {
    view.button(label).props.onClick();
  }
  assert.deepEqual(view.events, [["copy"], ["retry"], ["feedback", "positive"], ["feedback", "negative"], ["source", null], ["source", 1], ["source", 1]]);
  assert.equal(JSON.stringify(view.props.turn), previous);
  assert.equal(all(view.root, "article").length, 1);
  assert.equal(all(view.root, "section")[0].props["aria-live"], "polite");
  assert.ok(view.button("1").props.class.includes("citation-active"));
  assert.ok(view.button("1Article").props.class.includes("bg-accent text-foreground"));
});

test("retry, copy and feedback reflect parent-controlled status", async (t) => {
  const view = mount(t, { busy: true });
  assert.equal(view.button("重新生成").props.disabled, true);
  view.props.isLast = false;
  view.props.turn.copied = true;
  view.props.turn.feedbackBusy = true;
  view.props.activeCitation = null;
  await nextTick();
  assert.equal(view.button("重新生成"), undefined);
  assert.ok(view.button("已复制"));
  assert.equal(view.button("有帮助").props.disabled, true);
  assert.equal(view.button("需要改进").props.disabled, true);
  assert.ok(!view.button("1").props.class.includes("citation-active"));
  view.props.turn.feedbackBusy = false;
  view.props.turn.rating = "positive";
  await nextTick();
  assert.ok(text(view.root).includes("感谢反馈"));
  assert.equal(view.button("撤销有帮助").props.disabled, false);
  assert.equal(view.button("撤销有帮助").props["aria-pressed"], true);
  assert.equal(view.button("需要改进").props.disabled, false);
  assert.equal(view.button("需要改进").props["aria-pressed"], false);
  view.button("撤销有帮助").props.onClick();
  view.button("需要改进").props.onClick();
  assert.deepEqual(view.events, [["feedback", null], ["feedback", "negative"]]);
  assert.equal(view.props.turn.rating, "positive", "actions wait for parent-controlled persistence");
});

test("negative feedback supports reversal, switching and reason toggles without mutating saved reasons", async (t) => {
  const view = mount(t);
  view.props.turn.rating = "negative";
  view.props.turn.feedbackReasons = ["outdated"];
  await nextTick();
  assert.equal(view.button("撤销需要改进").props["aria-pressed"], true);
  assert.equal(view.button("内容过时").props["aria-pressed"], true);
  assert.equal(view.button("答案错误").props["aria-pressed"], false);
  view.button("内容过时").props.onClick();
  view.button("答案错误").props.onClick();
  view.button("撤销需要改进").props.onClick();
  view.button("有帮助").props.onClick();
  assert.deepEqual(view.events, [["feedback", "negative", []], ["feedback", "negative", ["outdated", "incorrect-answer"]], ["feedback", null], ["feedback", "positive"]]);
  assert.deepEqual(view.props.turn.feedbackReasons, ["outdated"]);
  view.props.turn.feedbackBusy = true;
  await nextTick();
  for (const label of ["撤销需要改进", "有帮助", "资料未召回", "答案错误", "引用不符", "内容过时", "其他"]) assert.equal(view.button(label).props.disabled, true);
  view.props.turn.feedbackBusy = false;
  view.props.turn.rating = null;
  view.props.turn.feedbackReasons = [];
  await nextTick();
  assert.equal(view.button("内容过时"), undefined);
  assert.equal(view.button("需要改进").props["aria-pressed"], false);
});

test("streaming placeholder, stopped notice and unsaved actions retain their visibility rules", async (t) => {
  const view = mount(t, { turn: { question: "Question", answer: "", sources: [], rating: null, streaming: true } });
  assert.ok(text(view.root).includes("正在检索知识库…"));
  assert.equal(all(view.root, "button").length, 0);
  assert.ok(all(view.root, "p").some((item) => item.props.class?.includes("streaming-cursor")));
  view.props.turn.streaming = false;
  view.props.turn.notice = "已停止生成，本轮回答未保存。";
  view.props.turn.answerMode = "extractive";
  await nextTick();
  assert.ok(text(view.root).includes("知识库原文摘录"));
  assert.ok(text(view.root).includes("暂无匹配文章"));
  assert.ok(text(view.root).includes(view.props.turn.notice));
  assert.ok(view.button("重新生成"));
  assert.equal(view.button("复制"), undefined);
  assert.equal(view.button("有帮助"), undefined);
});
