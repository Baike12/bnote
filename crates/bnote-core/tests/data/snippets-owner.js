// bnote 仓库级 LaTeX 片段 —— 在这里或「设置 → 公式片段」里编辑，保存后立即生效。
//
// 本文件存在时**完全取代**内置片段集（src/editor/snippets/default-snippets.ts），不是叠加。
// 删掉本文件，或在设置里点「恢复内置片段」，即回到内置集。
//
// 整理自 obsidian-vim-input-auto-switch 的 data.json（214 条）：按语义分组、去重
// （同名 trigger 先出现者胜）、补注释。
// 末尾「bnote 内置补充项」是内置集里有、插件里没有的片段。
//
// 字段：
//   trigger     字符串，或正则字面量 /…/；正则里 [[0]] 引用第 1 个捕获组
//   replacement $0 $1… 制表位（$0 最先跳入）；${0:默认文本} 带默认值；
//               [[n]] 正则捕获组；${VISUAL} 选中内容；只有 \$ 和 \\ 是转义
//   options     模式 m 行内+块级公式 / n 仅行内公式 / M 仅块级公式 / t 普通文本 /
//                     T 文本环境 / c 代码块 / C 行内代码（模式一个都不写 = 任何位置都触发）
//               行为 A 自动展开（免 Tab）/ r 正则 / w 词边界 / v 需有选区
//   priority    越大越先匹配，默认 0
//
// 变量 ${GREEK} ${SYMBOL} ${MORE_SYMBOLS} ${ACCENT} 编译前替换，定义见
// src/editor/snippets/default-variables.ts。

export default [
  // ── 数学环境骨架（$$…$$ / align） ───────────────────────────────
  { trigger: "#@", replacement: "$$\n\\begin{align}\n$0\n\\end{align}\n$$", options: "tA" },
  { trigger: "##@", replacement: "$$0$", options: "tA" },
  { trigger: "ma", replacement: "$$0$", options: "tA" },
  { trigger: "dm", replacement: "$$\n\\begin{align}\n$0\n\\end{align}\n$$", options: "tAw" },
  { trigger: "beg", replacement: "\\begin{$0}\n$1\n\\end{$0}", options: "mA" },

  // ── 希腊字母 ────────────────────────────────────────────────
  { trigger: "aa", replacement: "\\alpha", options: "mA" },
  { trigger: "bb", replacement: "\\beta", options: "mA" },
  { trigger: "gg", replacement: "\\gamma", options: "mA" },
  { trigger: "GG", replacement: "\\Gamma", options: "mA" },
  { trigger: "dd", replacement: "\\delta", options: "mA" },
  { trigger: "DD", replacement: "\\Delta", options: "mA" },
  { trigger: "ee", replacement: "\\epsilon", options: "mA" },
  { trigger: ":e", replacement: "\\varepsilon", options: "mA" },
  { trigger: "zz", replacement: "\\zeta", options: "mA" },
  { trigger: "tt", replacement: "\\theta", options: "mA" },
  { trigger: "TT", replacement: "\\Theta", options: "mA" },
  { trigger: ":t", replacement: "\\vartheta", options: "mA" },
  { trigger: "io", replacement: "\\iota", options: "mA" },
  { trigger: "kk", replacement: "\\kappa", options: "mA" },
  { trigger: "ll", replacement: "\\lambda", options: "mA" },
  { trigger: "LL", replacement: "\\Lambda", options: "mA" },
  { trigger: "ss", replacement: "\\sigma", options: "mA" },
  { trigger: "SS", replacement: "\\Sigma", options: "mA" },
  { trigger: "uu", replacement: "\\upsilon", options: "mA" },
  { trigger: "UU", replacement: "\\Upsilon", options: "mA" },
  { trigger: "oo", replacement: "\\omega", options: "mA" },
  { trigger: "OO", replacement: "\\Omega", options: "mA" },
  { trigger: "ome", replacement: "\\omega", options: "mA" },
  { trigger: "Ome", replacement: "\\Omega", options: "mA" },

  // ── 单字符 → LaTeX（前缀符号） ───────────────────────────────────
  { trigger: "pa", replacement: "\\partial", options: "mA" },
  { trigger: "spa", replacement: "~", options: "mA" },
  { trigger: "dl", replacement: "\\displaylines{ \\ \n $0 \n}", options: "mA" },
  { trigger: "ad", replacement: "+", options: "mA" },
  { trigger: "sb", replacement: "-", options: "mA" },
  { trigger: "mt", replacement: "*", options: "mA" },
  { trigger: "sj", replacement: "_{$0}", options: "mA" },
  { trigger: "sk", replacement: "^{$0}", options: "mA" },
  { trigger: "ap", replacement: "\\approx", options: "mA" },

  // ── 文本 ──────────────────────────────────────────────────
  { trigger: "text", replacement: "\\text{$0}$1", options: "mA" },
  { trigger: "\"", replacement: "\\text{$0}$1", options: "mA" },

  // ── 上下标 / 根号 / 幂 ────────────────────────────────────────
  { trigger: "sr", replacement: "^{2}", options: "mA" },
  { trigger: "cb", replacement: "^{3}", options: "mA" },
  { trigger: "rd", replacement: "^{$0}$1", options: "mA" },
  { trigger: "_", replacement: "_{$0}$1", options: "mA" },
  { trigger: "sts", replacement: "_\\text{$0}", options: "mA" },
  { trigger: "sq", replacement: "\\sqrt{ $0 }$1", options: "mA" },
  { trigger: "ee", replacement: "e^{ $0 }$1", options: "mA" },
  // 注：同名 "ee" 已被上面希腊字母节的 { ee → \epsilon } 占位（先出现者胜），本条实际不生效。
  //     想用指数写法就把它挪到希腊字母节之前，或把其中一条改成别的 trigger。
  { trigger: "invs", replacement: "^{-1}", options: "mA" },
  { trigger: "conj", replacement: "^{*}", options: "mA" },

  // ── 字体 / 算子名 / 常用记号 ─────────────────────────────────────
  // 输入 log 自动补成 \log（latex-suite 里 exp|log|ln 那条规则，这里只取 log）。
  // 负向后顾 (?<!\\) 是关键：手动打 \log 时紧跟在反斜杠后的 log 不匹配，
  // 否则会被再补一层反斜杠，变成 \\log。
  { trigger: /(?<!\\)log/, replacement: "\\log", options: "mA" },
  { trigger: "Re", replacement: "\\mathrm{Re}", options: "mA" },
  { trigger: "Im", replacement: "\\mathrm{Im}", options: "mA" },
  { trigger: "bf", replacement: "\\mathbf{$0}", options: "mA" },
  { trigger: "rm", replacement: "\\mathrm{$0}$1", options: "mA" },
  { trigger: "trace", replacement: "\\mathrm{Tr}", options: "mA" },
  { trigger: "ooo", replacement: "\\infty", options: "mA" },

  // ── 重音与向量 ───────────────────────────────────────────────
  { trigger: "([a-zA-Z])hat", replacement: "\\hat{[[0]]}", options: "rmA" },
  { trigger: "([a-zA-Z])bar", replacement: "\\bar{[[0]]}", options: "rmA" },
  { trigger: "([a-zA-Z])dot", replacement: "\\dot{[[0]]}", options: "rmA", priority: -1 },
  { trigger: "([a-zA-Z])ddot", replacement: "\\ddot{[[0]]}", options: "rmA", priority: 1 },
  { trigger: "([a-zA-Z])til", replacement: "\\tilde{[[0]]}", options: "rmA" },
  { trigger: "([a-zA-Z])und", replacement: "\\underline{[[0]]}", options: "rmA" },
  { trigger: "ve([a-zA-Z])", replacement: "\\vec{[[0]]}", options: "rmA" },
  { trigger: "ma([a-zA-Z])", replacement: "\\mathbf{[[0]]}", options: "rmA" },
  { trigger: "mc([a-zA-Z])", replacement: "\\mathcal{[[0]]}", options: "rmA" },
  { trigger: "([a-zA-Z]),\\.", replacement: "\\mathbf{[[0]]}", options: "rmA" },
  { trigger: "([a-zA-Z])\\.,", replacement: "\\mathbf{[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}),\\.", replacement: "\\boldsymbol{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK})\\.,", replacement: "\\boldsymbol{\\[[0]]}", options: "rmA" },
  { trigger: "hat", replacement: "\\hat{$0}$1", options: "mA" },
  { trigger: "bar", replacement: "\\bar{$0}$1", options: "mA" },
  { trigger: "dot", replacement: "\\dot{$0}$1", options: "mA", priority: -1 },
  { trigger: "ddot", replacement: "\\ddot{$0}$1", options: "mA" },
  { trigger: "cdot", replacement: "\\cdot", options: "mA" },
  { trigger: "tilde", replacement: "\\tilde{$0}$1", options: "mA" },
  { trigger: "und", replacement: "\\underline{$0}$1", options: "mA" },
  { trigger: "vec", replacement: "\\vec{$0}$1", options: "mA" },

  // ── 常用变量 ────────────────────────────────────────────────
  { trigger: "xnn", replacement: "x_{n}", options: "mA" },
  { trigger: "xii", replacement: "x_{i}", options: "mA" },
  { trigger: "xjj", replacement: "x_{j}", options: "mA" },
  { trigger: "xp1", replacement: "x_{n+1}", options: "mA" },
  { trigger: "ynn", replacement: "y_{n}", options: "mA" },
  { trigger: "yii", replacement: "y_{i}", options: "mA" },
  { trigger: "yjj", replacement: "y_{j}", options: "mA" },

  // ── 求和 / 连乘 / 极限 ────────────────────────────────────────
  { trigger: "sum", replacement: "\\sum_{${0:i}=${1:1}}^{${2:N}} $3", options: "mA" },
  { trigger: "pr", replacement: "\\prod_{${0:i}=${1:1}}^{${2:N}} $3", options: "mA" },
  { trigger: "lim", replacement: "\\lim_{ ${0:n} \\to ${1:\\infty} } $2", options: "mA" },

  // ── 运算符与关系符 ─────────────────────────────────────────────
  { trigger: "+-", replacement: "\\pm", options: "mA" },
  { trigger: "-+", replacement: "\\mp", options: "mA" },
  { trigger: "...", replacement: "\\dots", options: "mA" },
  { trigger: "nabl", replacement: "\\nabla", options: "mA" },
  { trigger: "del", replacement: "\\nabla", options: "mA" },
  { trigger: "xx", replacement: "\\times", options: "mA" },
  { trigger: "**", replacement: "\\cdot", options: "mA" },
  { trigger: "para", replacement: "\\parallel", options: "mA" },
  { trigger: "===", replacement: "\\equiv", options: "mA" },
  { trigger: "!=", replacement: "\\neq", options: "mA" },
  { trigger: ">=", replacement: "\\geq", options: "mA" },
  { trigger: "<=", replacement: "\\leq", options: "mA" },
  { trigger: ">>", replacement: "\\gg", options: "mA" },
  { trigger: "<<", replacement: "\\ll", options: "mA" },
  // 输入 sim 自动补成 \sim。写成正则而不是普通 trigger,是因为下面还有
  // simm / sim= 两条更长的普通 trigger：普通 trigger 匹配时不会看后面的字符,
  // “sim” 会先把 simm / sim= 抢掉。负向后顾跳过手打的 \sim(否则叠成两层反斜杠),
  // 负向先行在 simm / sim= 上让位。
  { trigger: /(?<!\\)sim(?![-=])/, replacement: "\\sim", options: "mA" },
  { trigger: "simm", replacement: "\\sim", options: "mA" },
  { trigger: "sim=", replacement: "\\simeq", options: "mA" },
  { trigger: "prop", replacement: "\\propto", options: "mA" },

  // ── 箭头 ──────────────────────────────────────────────────
  { trigger: "<->", replacement: "\\leftrightarrow ", options: "mA" },
  { trigger: "<-", replacement: "\\leftarrow ", options: "mA" },
  { trigger: "->", replacement: "\\to", options: "mA" },
  { trigger: "!>", replacement: "\\mapsto", options: "mA" },
  { trigger: "=>", replacement: "\\implies", options: "mA" },
  { trigger: "=<", replacement: "\\impliedby", options: "mA" },

  // ── 集合与逻辑 ───────────────────────────────────────────────
  { trigger: "and", replacement: "\\cap", options: "mA" },
  { trigger: "orr", replacement: "\\cup", options: "mA" },
  { trigger: "inc", replacement: "\\in", options: "mA" },
  { trigger: "notin", replacement: "\\not\\in", options: "mA" },
  { trigger: "\\\\\\", replacement: "\\setminus", options: "mA" },
  { trigger: "sub=", replacement: "\\subseteq", options: "mA" },
  { trigger: "sup=", replacement: "\\supseteq", options: "mA" },
  { trigger: "eset", replacement: "\\emptyset", options: "mA" },
  { trigger: "set", replacement: "\\{ $0 \\}$1", options: "mA" },
  { trigger: "exs", replacement: "\\exists", options: "mA", priority: 1 },

  // ── 数集 / 花体 ─────────────────────────────────────────────
  { trigger: "LL", replacement: "\\mathcal{L}", options: "mA" },
  // 注：同名 "LL" 已被希腊字母节的 { LL → \Lambda } 占位，本条实际不生效。
  { trigger: "HH", replacement: "\\mathcal{H}", options: "mA" },
  { trigger: "CC", replacement: "\\mathbb{C}", options: "mA" },
  { trigger: "RR", replacement: "\\mathbb{R}", options: "mA" },
  { trigger: "ZZ", replacement: "\\mathbb{Z}", options: "mA" },
  { trigger: "NN", replacement: "\\mathbb{N}", options: "mA" },

  // ── 微积分 ─────────────────────────────────────────────────
  { trigger: "par", replacement: "\\frac{ \\partial ${0:y} }{ \\partial ${1:x} } $2", options: "m" },
  { trigger: /pa([A-Za-z])([A-Za-z])/, replacement: "\\frac{ \\partial [[0]] }{ \\partial [[1]] } ", options: "rm" },
  { trigger: "ddt", replacement: "\\frac{d}{dt} ", options: "mA" },
  { trigger: /([^\\])int/, replacement: "[[0]]\\int", options: "mA", priority: -1 },
  { trigger: "\\int", replacement: "\\int $0 \\, d${1:x} $2", options: "m" },
  { trigger: "dint", replacement: "\\int_{${0:0}}^{${1:1}} $2 \\, d${3:x} $4", options: "mA" },
  { trigger: "oint", replacement: "\\oint", options: "mA" },
  { trigger: "iint", replacement: "\\iint", options: "mA" },
  { trigger: "iiint", replacement: "\\iiint", options: "mA" },
  { trigger: "oinf", replacement: "\\int_{0}^{\\infty} $0 \\, d${1:x} $2", options: "mA" },
  { trigger: "infi", replacement: "\\int_{-\\infty}^{\\infty} $0 \\, d${1:x} $2", options: "mA" },

  // ── 正则自动化（自动补反斜杠 / 自动下标 / 自动加空格） ────────────────────────
  { trigger: /([A-Za-z])(\d)/, replacement: "[[0]]_{[[1]]}", options: "rmA", priority: -1, description: "Auto letter subscript" },
  { trigger: /([^\\])(det)/, replacement: "[[0]]\\[[1]]", options: "rmA" },
  { trigger: /([A-Za-z])_(\d\d)/, replacement: "[[0]]_{[[1]]}", options: "rmA" },
  { trigger: /\\hat{([A-Za-z])}(\d)/, replacement: "\\hat{[[0]]}_{[[1]]}", options: "rmA" },
  { trigger: /\\vec{([A-Za-z])}(\d)/, replacement: "\\vec{[[0]]}_{[[1]]}", options: "rmA" },
  { trigger: /\\mathbf{([A-Za-z])}(\d)/, replacement: "\\mathbf{[[0]]}_{[[1]]}", options: "rmA" },
  { trigger: "([^\\\\])(${GREEK})", replacement: "[[0]]\\[[1]]", options: "rmA", description: "Add backslash before Greek letters" },
  { trigger: "([^\\\\])(${SYMBOL})", replacement: "[[0]]\\[[1]]", options: "rmA", description: "Add backslash before symbols" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}|${MORE_SYMBOLS})([A-Za-z])", replacement: "\\[[0]] [[1]]", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) sr", replacement: "\\[[0]]^{2}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) cb", replacement: "\\[[0]]^{3}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) rd", replacement: "\\[[0]]^{$0}$1", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) hat", replacement: "\\hat{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) dot", replacement: "\\dot{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) bar", replacement: "\\bar{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) vec", replacement: "\\vec{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) tilde", replacement: "\\tilde{\\[[0]]}", options: "rmA" },
  { trigger: "\\\\(${GREEK}|${SYMBOL}) und", replacement: "\\underline{\\[[0]]}", options: "rmA" },
  { trigger: /([^\\])(arcsin|sin|arccos|cos|arctan|tan|csc|sec|cot)/, replacement: "[[0]]\\[[1]]", options: "rmA", description: "Add backslash before trig funcs" },
  { trigger: /\\(arcsin|sin|arccos|cos|arctan|tan|csc|sec|cot)([A-Za-gi-z])/, replacement: "\\[[0]] [[1]]", options: "rmA", description: "Add space after trig funcs. Skips letter h to allow sinh, cosh, etc." },
  { trigger: /\\(sinh|cosh|tanh|coth)([A-Za-z])/, replacement: "\\[[0]] [[1]]", options: "rmA", description: "Add space after hyperbolic trig funcs" },

  // ── 视觉选区（选中后按 Tab 包裹） ───────────────────────────────────
  { trigger: "U", replacement: "\\underbrace{ ${VISUAL} }_{ $0 }", options: "mA" },
  { trigger: "O", replacement: "\\overbrace{ ${VISUAL} }^{ $0 }", options: "mA" },
  { trigger: "B", replacement: "\\underset{ $0 }{ ${VISUAL} }", options: "mA" },
  { trigger: "C", replacement: "\\cancel{ ${VISUAL} }", options: "mA" },
  { trigger: "K", replacement: "\\cancelto{ $0 }{ ${VISUAL} }", options: "mA" },
  { trigger: "S", replacement: "\\sqrt{ ${VISUAL} }", options: "mA" },

  // ── 物理 / 量子力学 / 化学 ──────────────────────────────────────
  { trigger: "kbt", replacement: "k_{B}T", options: "mA" },
  { trigger: "msun", replacement: "M_{\\odot}", options: "mA" },
  { trigger: "dag", replacement: "^{\\dagger}", options: "mA" },
  { trigger: "o+", replacement: "\\oplus ", options: "mA" },
  { trigger: "ox", replacement: "\\otimes ", options: "mA" },
  { trigger: "bra", replacement: "\\bra{$0} $1", options: "mA" },
  { trigger: "ket", replacement: "\\ket{$0} $1", options: "mA" },
  { trigger: "brk", replacement: "\\braket{ $0 | $1 } $2", options: "mA" },
  { trigger: "outer", replacement: "\\ket{${0:\\psi}} \\bra{${0:\\psi}} $1", options: "mA" },
  { trigger: "pu", replacement: "\\pu{ $0 }", options: "mA" },
  { trigger: "cee", replacement: "\\ce{ $0 }", options: "mA" },
  { trigger: "he4", replacement: "{}^{4}_{2}He ", options: "mA" },
  { trigger: "he3", replacement: "{}^{3}_{2}He ", options: "mA" },
  { trigger: "iso", replacement: "{}^{${0:4}}_{${1:2}}${2:He}", options: "mA" },

  // ── 矩阵 / 分段 / 对齐 ────────────────────────────────────────
  { trigger: "pm", replacement: "\\begin{pmatrix}\n$0\n\\end{pmatrix}", options: "MA" },
  { trigger: "bm", replacement: "\\begin{bmatrix}\n$0\n\\end{bmatrix}", options: "MA" },
  { trigger: "Bm", replacement: "\\begin{Bmatrix}\n$0\n\\end{Bmatrix}", options: "MA" },
  { trigger: "vm", replacement: "\\begin{vmatrix}\n$0\n\\end{vmatrix}", options: "MA" },
  { trigger: "Vm", replacement: "\\begin{Vmatrix}\n$0\n\\end{Vmatrix}", options: "MA" },
  { trigger: "matrix", replacement: "\\begin{matrix}\n$0\n\\end{matrix}", options: "MA" },
  // matrix 两条不冲突：MA 只在块级公式触发，nA 只在行内公式触发。
  { trigger: "pmat", replacement: "\\begin{pmatrix}$0\\end{pmatrix}", options: "nA" },
  { trigger: "bmat", replacement: "\\begin{bmatrix}$0\\end{bmatrix}", options: "nA" },
  { trigger: "Bmat", replacement: "\\begin{Bmatrix}$0\\end{Bmatrix}", options: "nA" },
  { trigger: "vmat", replacement: "\\begin{vmatrix}$0\\end{vmatrix}", options: "nA" },
  { trigger: "Vmat", replacement: "\\begin{Vmatrix}$0\\end{Vmatrix}", options: "nA" },
  { trigger: "matrix", replacement: "\\begin{matrix}$0\\end{matrix}", options: "nA" },
  { trigger: "cases", replacement: "\\begin{cases}\n$0\n\\end{cases}", options: "mA" },
  { trigger: "ali", replacement: "\\begin{align}\n$0\n\\end{align}", options: "mA" },
  { trigger: "arr", replacement: "\\begin{array} \\ \n$0\n\\end{array}", options: "mA" },

  // ── 括号与定界符 ──────────────────────────────────────────────
  { trigger: "avg", replacement: "\\langle $0 \\rangle $1", options: "mA" },
  { trigger: "norm", replacement: "\\lvert $0 \\rvert $1", options: "mA", priority: 1 },
  { trigger: "Norm", replacement: "\\lVert $0 \\rVert $1", options: "mA", priority: 1 },
  { trigger: "ceil", replacement: "\\lceil $0 \\rceil $1", options: "mA" },
  { trigger: "flo", replacement: "\\lfloor $0 \\rfloor $1", options: "mA" },
  { trigger: "mod", replacement: "|$0|$1", options: "mA" },
  { trigger: "(", replacement: "(${VISUAL})", options: "mA" },
  { trigger: "[", replacement: "[${VISUAL}]", options: "mA" },
  { trigger: "{", replacement: "{${VISUAL}}", options: "mA" },
  // ( [ { 各两条：带 ${VISUAL} 的只在有选区时触发，无选区时落到下面的 $0 版。
  { trigger: "(", replacement: "($0)$1", options: "mA" },
  { trigger: "{", replacement: "{$0}$1", options: "mA" },
  { trigger: "[", replacement: "[$0]$1", options: "mA" },
  { trigger: "lr(", replacement: "\\left( $0 \\right) $1", options: "mA" },
  { trigger: "lr{", replacement: "\\left\\{ $0 \\right\\} $1", options: "mA" },
  { trigger: "lr[", replacement: "\\left[ $0 \\right] $1", options: "mA" },
  { trigger: "lr|", replacement: "\\left| $0 \\right| $1", options: "mA" },
  { trigger: "lra", replacement: "\\left< $0 \\right> $1", options: "mA" },

  // ── 其他 ──────────────────────────────────────────────────
  { trigger: "tayl", replacement: "${0:f}(${1:x} + ${2:h}) = ${0:f}(${1:x}) + ${0:f}'(${1:x})${2:h} + ${0:f}''(${1:x}) \\frac{${2:h}^{2}}{2!} + \\dots$3", options: "mA", description: "Taylor expansion" },
  // 函数型 replacement（引擎已支持：入参是正则的 exec 结果数组，返回值直接当替换文本）。
  // 行分隔用 String.raw 写，所见即所得——少一条反斜杠就不是换行而是字面 \n，矩阵会渲染错。
  { trigger: /iden(\d)/, replacement: (match) => {
      const n = Number(match[1]);
      const rows = [];
      for (let j = 0; j < n; j++) {
        rows.push(Array.from({ length: n }, (_, i) => (i === j ? "1" : "0")).join(" & "));
      }
      return `\\begin{pmatrix}\n${rows.join(String.raw` \\` + "\n")}\n\\end{pmatrix}`;
    }, options: "mA", description: "N×N 单位阵" },

  // ── bnote 内置补充项（插件 data.json 里没有，保留自 default-snippets.ts）──────
  { trigger: "al", replacement: "\\alpha", options: "m" },
  { trigger: "mk", replacement: "$$0$", options: "tA" },
  { trigger: "mk", replacement: "\\($0\\)", options: "TA" },
  { trigger: "QQ", replacement: "\\mathbb{Q}", options: "mA" },
  { trigger: "deg", replacement: "\\degree", options: "mA" },
  { trigger: "floor", replacement: "\\lfloor $0 \\rfloor $1", options: "mA" },
  { trigger: "pmod", replacement: "\\pmod{${0:n}}$1", options: "mA", description: "带括号的取模" },
  { trigger: /par([0-9])/, replacement: "\\frac{ \\partial^{[[0]]} ${0:y} }{ \\partial ${1:x}^{[[0]]} } $2", options: "mA" },
  { trigger: /parn/, replacement: "\\frac{ \\partial^{${0:n}} ${1:y} }{ \\partial ${2:x}^{${0:n}} } $2", options: "mA" },
  { trigger: /(arccsc|arcsec|arccot)/, replacement: "\\operatorname{[[0]]}$0", options: "mA", priority: 1, description: "KaTeX 不内置的反三角函数" },
  { trigger: "\\sum", replacement: "\\sum_{${0:i}=${1:1}}^{${2:N}} $3", options: "m" },
  { trigger: "\\prod", replacement: "\\prod_{${0:i}=${1:1}}^{${2:N}} $3", options: "m" },
  { trigger: "(\\\\${GREEK}|[A-Za-z])_(\\d+)(\\d)", replacement: "[[0]]_{[[1]][[2]]}", options: "rmA", priority: -1 },
  { trigger: "\\\\(${ACCENT})\\{(\\\\${GREEK}|[A-Za-z])\\}(\\d)", replacement: "\\[[0]]{[[1]]}_{[[2]]}", options: "rmA", priority: -1 },
  { trigger: "\\\\(${ACCENT})\\{(\\\\${GREEK}|[A-Za-z])\\}_\\{(\\d+)\\}(\\d)", replacement: "\\[[0]]{[[1]]}_{[[2]][[3]]}", options: "rmA", priority: -1 },
  { trigger: "\\\\(${ACCENT})\\{\\\\(${ACCENT})\\{(\\\\${GREEK}|[A-Za-z])\\}\\}(\\d)", replacement: "\\[[0]]{\\[[1]]{[[2]]}}_{[[3]]}", options: "rmA", priority: -1 },
  { trigger: "\\\\(${ACCENT})\\{\\\\(${ACCENT})\\{(\\\\${GREEK}|[A-Za-z])\\}\\}_\\{(\\d+)\\}(\\d)", replacement: "\\[[0]]{\\[[1]]{[[2]]}}_{[[3]][[4]]}", options: "rmA", priority: -1 },
  { trigger: /(n?)e\\xi sts/, replacement: "\\[[0]]exists", options: "mA", priority: 1 },
  { trigger: /(\S\s*)dm/, replacement: "[[0]]\n$$\n\\begin{align}\n$0\n\\end{align}\n$$", options: "tAw", priority: 1, description: "行尾 dm 拆出块级公式(align 环境)" },
];
