import assert from "node:assert/strict";
import test from "node:test";
import { parseArticleTitle } from "../src/article/title.js";

// 用例取自 200 篇样本标题，覆盖常见写法与需要保守放弃的情况。
const meta = (journal: string, journalAbbreviation: string | null, institutions: string[]) => ({ journal, journalAbbreviation, institutions });

test("title parser extracts journal and institutions from academic news titles", () => {
  const cases: Array<[string, ReturnType<typeof meta>]> = [
    ["上海交通大学黄富强等AFM： 依托ZSA电子结构模型构筑高熵层状氧化物", meta("Advanced Functional Materials", "AFM", ["上海交通大学"])],
    ["浙江大学范修林、上海交通大学邓涛AM：三阴离子协同溶剂化重塑双电层", meta("Advanced Materials", "AM", ["浙江大学", "上海交通大学"])],
    // 机构名取最长且剩余部分为人名；简称（南航）与机构后缀（深研院、化物所）。
    ["西北工业大学马越、王建淦、南航郑滔团队  AM： 分子柱撑高熵MXene隔膜", meta("Advanced Materials", "AM", ["西北工业大学", "南航"])],
    ["北大深研院潘锋等AM： 可规模化氧化重构策略制备互连闭孔硬碳", meta("Advanced Materials", "AM", ["北大深研院"])],
    ["清华大学深圳国际研究生院周光敏Nature Synthesis！", meta("Nature Synthesis", null, ["清华大学深圳国际研究生院"])],
    ["中科院大连化物所李先锋、谢聪鑫、武汉大学陈胜利Nature Chemistry！", meta("Nature Chemistry", null, ["中科院大连化物所", "武汉大学"])],
    // 拉丁人名、机构与人名之间的空格、期刊缩写的大小写与点号差异。
    ["剑桥大学Clare P. Grey ACS Energy Lett.：破除假象！重新认识钠离子电池负极电解液", meta("ACS Energy Letters", "ACS Energy Lett.", ["剑桥大学"])],
    ["得克萨斯大学奥斯汀分校 Arumugam Manthiram团队JACS：调控脂肪酯烷基/烷氧基链长", meta("Journal of the American Chemical Society", "JACS", ["得克萨斯大学奥斯汀分校"])],
    ["阿贡国家实验室Khalil Amine、Chi‑Cheung Su团队Angew.：分子工程构筑乙酸烷氧基乙酯溶剂", meta("Angewandte Chemie International Edition", "Angew.", ["阿贡国家实验室"])],
    ["厦门大学董全峰团队Angew：突破被动物理保护范式！", meta("Angewandte Chemie International Edition", "Angew.", ["厦门大学"])],
    ["中国科学院化学研究所郭玉国、张娟Sci.Adv.：解锁高能量长循环电池新范式！", meta("Science Advances", "Sci. Adv.", ["中国科学院化学研究所"])],
    ["Nature Chemical engineering：MIT开发出可完全体内降解的纸基电池  ！", meta("Nature Chemical Engineering", null, [])],
    ["马里兰大学王春生，山田淳夫Nature Reviewes Materials：下一代电池电解液的理性设计新思路", meta("Nature Reviews Materials", "Nat. Rev. Mater.", ["马里兰大学"])],
    // 期刊前的「重磅」、导语与感叹号分隔、「联合」连接的另一机构。
    ["清华大学冯旭宁，北京科技大学侯俊先  重磅 EES｜不要迷信钠离子电池天然更安全！", meta("Energy & Environmental Science", "EES", ["清华大学", "北京科技大学"])],
    ["三大误区深度解析！ 清华大学深圳国际研究生院李宝华等EES：重新审视锂离子电池富镍层状氧化物正极", meta("Energy & Environmental Science", "EES", ["清华大学深圳国际研究生院"])],
    ["联合温州大学肖遥！四川大学孟岩团队ESM：破解钠基层状氧化物中锂迁移难题", meta("Energy Storage Materials", "ESM", ["温州大学", "四川大学"])],
    ["西南交通大学杨维清、徐春柳联合温州大学肖遥ESM：全新纤维素晶内溶胀策略", meta("Energy Storage Materials", "ESM", ["西南交通大学", "温州大学"])],
    ["广州大湾区科技有限公司&南洋理工大学&天津师范大学&福州大学AM：室温极速快充锂离子电池!", meta("Advanced Materials", "AM", ["广州大湾区科技有限公司", "南洋理工大学", "天津师范大学", "福州大学"])],
    // 只有期刊或只有机构；无法识别的项（宁德新能源（ATL））忽略，不影响其他机构。
    ["AFM：极端低温冻融致三元锂电池容量不可逆衰减的原子-分子级机制解析", meta("Advanced Functional Materials", "AFM", [])],
    ["ESM | 超薄原位聚合复合聚合物电解质助力高能量锂金属电池", meta("Energy Storage Materials", "ESM", [])],
    ["Energy & Fuels：多物理场融合KTR灵敏度系数", meta("Energy & Fuels", null, [])],
    ["首尔国立大学EES：界面电子重构驱动电荷重分布", meta("Energy & Environmental Science", "EES", ["首尔国立大学"])],
    ["西南大学戚钰若、徐茂文&宁德新能源（ATL）ACS Energy Lett.：分子拓扑锚定策略", meta("ACS Energy Letters", "ACS Energy Lett.", ["西南大学"])],
    ["北京化工大学王峰、牛津、新加坡国立大学杨会颖EES：锂锶共掺杂羟基磷灰石", meta("Energy & Environmental Science", "EES", ["北京化工大学", "牛津", "新加坡国立大学"])],
  ];
  for (const [title, expected] of cases) assert.deepEqual(parseArticleTitle(title), expected, title);
});

test("title parser returns null without a known journal next to the header", () => {
  for (const title of [
    "年度报告 | 2025-2026 电池年度报告官方中文版：韧性增长与市场重构",
    "2026 BAT365 通过界面层与新型电解液稳定锂金属负极",
    "专利情报-降低电解液水含量的补锂剂-比亚迪",
    "深耕多尺度结构完整性：华东理工大学 陈浩峰",
    "CATL一个电芯是如何诞生的",
    // 期刊不在词典中、期刊出现在标题中间或分隔符之后，均不猜测。
    "山西煤化所苏方远团队AI4Carbon综述观点：人工智能驱动电化学储能领域碳材料研究进展",
    "“自我感知、自我修复、自我防护”？Nature综述揭秘下一代智能电池",
    "电池研发进展：清华大学张三AM",
    // 全大写的词不等于期刊，期刊名也不能是更长拉丁词的一部分。
    "CTP 与 CTC：成组技术对比",
    "DREAM：电池研发平台",
    "eScience 之外：Science 与 Nature 的投稿经验",
    "",
  ]) assert.equal(parseArticleTitle(title), null, title);
  assert.equal(parseArticleTitle("XX大学eScience：新进展")?.journal, "eScience");
});

test("title parser ignores entries that are not institution plus person", () => {
  // 句子、超长「人名」、拉丁机构名与没有后缀的词都不当作机构。
  assert.deepEqual(parseArticleTitle("颠覆认知的研究成果、某某某某某团队AM：新进展")?.institutions, []);
  assert.deepEqual(parseArticleTitle("Stanford University Yi Cui JACS：新进展")?.institutions, []);
  assert.deepEqual(parseArticleTitle("宁德时代吴凯团队AM：新进展")?.institutions, []);
  // 北京联合大学不会因「联合」被拆开。
  assert.deepEqual(parseArticleTitle("北京联合大学张三AM：新进展")?.institutions, ["北京联合大学"]);
  // 同一机构在标题中出现多次只保留一次。
  assert.deepEqual(parseArticleTitle("浙江大学陆俊、浙江大学范修林AM：新进展")?.institutions, ["浙江大学"]);
});
