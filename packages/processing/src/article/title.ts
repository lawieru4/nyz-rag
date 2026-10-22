// 学术快讯标题解析：「机构 + 作者 + 期刊：正文标题」中的期刊与机构。
// 标题格式不统一，规则保守：期刊只认词典，且须紧挨标题头部末尾；只有识别出期刊才提取机构，
// 机构须是「纯汉字机构名 + 人名」的完整项，无法完整识别的项直接忽略，不做猜测。
import type { ArticleTitleMeta } from "@nyz-rag/types";

/** 期刊全称、常用缩写与标题中出现过的其他写法。匹配时忽略大小写、空格与点号。 */
const JOURNALS: Array<{ name: string; abbreviation?: string; aliases?: string[] }> = [
  { name: "Advanced Materials", abbreviation: "AM", aliases: ["Adv. Mater."] },
  { name: "Advanced Functional Materials", abbreviation: "AFM", aliases: ["Adv. Funct. Mater."] },
  { name: "Advanced Energy Materials", abbreviation: "AEM", aliases: ["Adv. Energy Mater."] },
  { name: "Advanced Science", abbreviation: "Adv. Sci." },
  { name: "Energy & Environmental Science", abbreviation: "EES", aliases: ["Energy Environ. Sci."] },
  { name: "Energy & Environmental Materials", abbreviation: "EEM" },
  { name: "Energy Storage Materials", abbreviation: "ESM", aliases: ["Energy Storage Mater."] },
  { name: "Journal of the American Chemical Society", abbreviation: "JACS", aliases: ["J. Am. Chem. Soc."] },
  { name: "Angewandte Chemie International Edition", abbreviation: "Angew.", aliases: ["Angew. Chem.", "Angew. Chem. Int. Ed."] },
  { name: "ACS Energy Letters", abbreviation: "ACS Energy Lett." },
  { name: "ACS Nano" },
  { name: "ACS Applied Materials & Interfaces", abbreviation: "ACS AMI", aliases: ["ACS Appl. Mater. Interfaces"] },
  { name: "Nano Letters", abbreviation: "Nano Lett." },
  { name: "Nano Energy" },
  { name: "Nature" },
  { name: "Science" },
  { name: "Science Advances", abbreviation: "Sci. Adv." },
  { name: "Nature Energy" },
  { name: "Nature Materials" },
  { name: "Nature Nanotechnology" },
  { name: "Nature Chemistry", aliases: ["Nat. Chem."] },
  { name: "Nature Communications", abbreviation: "Nat. Commun.", aliases: ["Nature Commun."] },
  { name: "Nature Synthesis" },
  { name: "Nature Sensors" },
  { name: "Nature Sustainability" },
  { name: "Nature Catalysis" },
  { name: "Nature Chemical Engineering" },
  { name: "Nature Reviews Materials", abbreviation: "Nat. Rev. Mater.", aliases: ["Nature Reviewes Materials"] },
  { name: "Joule" },
  { name: "eScience" },
  { name: "InfoMat" },
  { name: "Carbon Energy" },
  { name: "National Science Review", abbreviation: "NSR", aliases: ["Natl. Sci. Rev."] },
  { name: "Chemical Science", abbreviation: "Chem. Sci." },
  { name: "Chemical Reviews", abbreviation: "Chem. Rev." },
  { name: "Chemical Society Reviews", abbreviation: "Chem. Soc. Rev." },
  { name: "Energy & Fuels" },
  { name: "Industrial Chemistry & Materials" },
  { name: "Journal of Energy Chemistry", abbreviation: "J. Energy Chem.", aliases: ["JEC"] },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 点号可省略、空格可多可少；期刊名前不能紧接拉丁字母（AM 不匹配 xAM，Science 不匹配 eScience）。
const aliasPattern = (alias: string) => escape(alias).replace(/\\\./g, "\\.?").replace(/\s+/g, "\\s*");
const JOURNAL_PATTERNS = JOURNALS
  .flatMap((journal) => [journal.name, journal.abbreviation, ...(journal.aliases ?? [])].filter((alias): alias is string => Boolean(alias)).map((alias) => ({ alias, journal })))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ alias, journal }) => ({ pattern: new RegExp(`(?<![A-Za-z])${aliasPattern(alias)}\\s*$`, "i"), journal }));

// 标题头部与正文标题的分隔符；没有分隔符时整个标题（去掉末尾感叹号）须以期刊结尾。
const HEADER_SEPARATOR = /\s*[：:｜|]/;
// 作者项分隔：顿号、逗号、&、感叹号等句末标点（前面的导语成为无法识别的项被忽略），以及汉字之间的空白。
const ENTRY_SEPARATOR = /\s*[、，,;；&＆！!？?。]\s*|(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/;
const HAN_INSTITUTION = /^[\u4e00-\u9fff]{3,}$/;
const INSTITUTION_SUFFIX = /(?:大学|院|所|分校|实验室|公司|中心|集团)$/;
// 不带机构后缀的常用简称。
const INSTITUTION_ABBREVIATIONS = new Set(["北大", "清华", "复旦", "浙大", "南大", "中科大", "港科大", "哈工大", "北航", "南航", "北理工", "华科", "牛津", "剑桥"]);
const PERSON_SUFFIX = /(?:等人|等|团队|课题组|教授)$/;
const HAN_NAME = /^[\u4e00-\u9fff]{2,4}$/;
const LATIN_NAME = /^[A-Z][A-Za-z'’.\-‑ ]*[A-Za-z.]$/;

function isPerson(value: string): boolean {
  let rest = value.trim();
  while (PERSON_SUFFIX.test(rest)) rest = rest.replace(PERSON_SUFFIX, "").trim();
  return !rest || HAN_NAME.test(rest) || LATIN_NAME.test(rest);
}

const isInstitution = (value: string) => INSTITUTION_ABBREVIATIONS.has(value) || (HAN_INSTITUTION.test(value) && INSTITUTION_SUFFIX.test(value));

/** 「机构 + 人名」或单独的机构；取能让剩余部分成为人名的最长机构名。 */
function entryInstitution(entry: string): string | null {
  for (let end = entry.length; end >= 2; end -= 1) {
    const institution = entry.slice(0, end);
    if (isInstitution(institution) && isPerson(entry.slice(end))) return institution;
  }
  return null;
}

function institutionOf(entry: string): string | null {
  // 「徐春柳联合温州大学肖遥」：联合前是上一机构的作者。
  const joint = entry.match(/^(.*?)联合(.+)$/);
  if (joint && isPerson(joint[1])) {
    const institution = entryInstitution(joint[2]);
    if (institution && institution.length >= 4) return institution;
  }
  return entryInstitution(entry);
}

function matchJournal(header: string) {
  for (const { pattern, journal } of JOURNAL_PATTERNS) {
    const match = header.match(pattern);
    if (match) return { journal, authors: header.slice(0, match.index).trim() };
  }
  return null;
}

/** 从标题中提取期刊与机构；未识别出期刊时返回 null。机构保留标题中的写法，按出现顺序去重。 */
export function parseArticleTitle(title: string): ArticleTitleMeta | null {
  const text = title.normalize("NFC").trim();
  const separator = text.match(HEADER_SEPARATOR);
  const header = separator ? text.slice(0, separator.index) : text.replace(/[！!]+$/, "");
  const matched = matchJournal(header.trim());
  if (!matched) return null;
  const institutions = matched.authors.split(ENTRY_SEPARATOR).map((entry) => institutionOf(entry.trim())).filter((value): value is string => Boolean(value));
  return { institutions: [...new Set(institutions)], journal: matched.journal.name, journalAbbreviation: matched.journal.abbreviation ?? null };
}
