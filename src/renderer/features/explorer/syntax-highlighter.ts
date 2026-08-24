export type TokenType =
  | "comment"
  | "string"
  | "keyword"
  | "type"
  | "function"
  | "property"
  | "number"
  | "boolean"
  | "operator"
  | "punctuation"
  | "tag"
  | "attr-name"
  | "attr-value"
  | "decorator"
  | "heading"
  | "link"
  | "regex"
  | "plain";

export type Token = {
  type: TokenType;
  text: string;
};

type Rule = {
  type: TokenType;
  regex: RegExp;
};

export function detectLanguage(filenameOrPath: string): string {
  const ext = filenameOrPath.includes(".")
    ? filenameOrPath.slice(filenameOrPath.lastIndexOf(".")).toLowerCase()
    : "";
  const name = filenameOrPath.split("/").pop()?.toLowerCase() || "";

  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === "package.json" || name === "tsconfig.json") return "json";

  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".json": "json",
    ".jsonl": "json",
    ".html": "html",
    ".htm": "html",
    ".xhtml": "html",
    ".svg": "xml",
    ".xml": "xml",
    ".css": "css",
    ".scss": "scss",
    ".sass": "scss",
    ".less": "css",
    ".md": "markdown",
    ".markdown": "markdown",
    ".py": "python",
    ".pyw": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".rb": "ruby",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".env": "bash",
    ".diff": "diff",
    ".patch": "diff",
    ".lua": "lua",
    ".swift": "swift",
  };
  return map[ext] || "plain";
}

function normalizeLanguage(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (l === "ts" || l === "typescript" || l === "mts" || l === "cts") return "typescript";
  if (l === "tsx") return "tsx";
  if (l === "js" || l === "javascript" || l === "mjs" || l === "cjs") return "javascript";
  if (l === "jsx") return "jsx";
  if (l === "json" || l === "jsonl") return "json";
  if (l === "html" || l === "htm" || l === "xhtml") return "html";
  if (l === "xml" || l === "svg") return "xml";
  if (l === "css" || l === "scss" || l === "sass" || l === "less") return "css";
  if (l === "py" || l === "python") return "python";
  if (l === "rs" || l === "rust") return "rust";
  if (l === "go") return "go";
  if (l === "java" || l === "kotlin" || l === "kt" || l === "csharp" || l === "cs") return "java";
  if (l === "c" || l === "cpp" || l === "h" || l === "hpp" || l === "cc") return "c";
  if (l === "sh" || l === "bash" || l === "zsh" || l === "shell") return "bash";
  if (l === "sql") return "sql";
  if (l === "md" || l === "markdown") return "markdown";
  if (l === "yaml" || l === "yml" || l === "toml" || l === "ini") return "yaml";
  return "generic";
}

function createRules(lang: string): Rule[] {
  const norm = normalizeLanguage(lang);

  // Common tokens
  const whitespaceRule: Rule = { type: "plain", regex: /[^\S\r\n]+/y };
  const newlineRule: Rule = { type: "plain", regex: /\r?\n/y };

  if (norm === "typescript" || norm === "tsx" || norm === "javascript" || norm === "jsx") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y },
      {
        type: "regex",
        regex: /\/(?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+\/[gimyus]*/y,
      },
      { type: "decorator", regex: /@[a-zA-Z_$][a-zA-Z0-9_$]*/y },
      {
        type: "keyword",
        regex: /\b(?:import|export|from|as|default|function|class|extends|implements|interface|type|enum|const|let|var|return|if|else|switch|case|break|continue|for|while|do|try|catch|finally|throw|new|typeof|instanceof|void|delete|in|of|async|await|yield|static|public|private|protected|readonly|abstract|override|declare|namespace|module|constructor|get|set|debugger)\b/y,
      },
      {
        type: "boolean",
        regex: /\b(?:true|false|null|undefined|NaN|Infinity|this|super|window|document|globalThis|process|console)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:string|number|boolean|symbol|bigint|any|unknown|never|object|void|Record|Array|Promise|Map|Set|WeakMap|WeakSet|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|Parameters|ReturnType|InstanceType|ReactNode|ReactElement|JSX|FC|PropsWithChildren)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_$]*\b/y },
      { type: "function", regex: /[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
      { type: "property", regex: /[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*:)/y },
      { type: "tag", regex: /<\/?(?:[a-zA-Z][a-zA-Z0-9.-]*)/y },
      {
        type: "number",
        regex: /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y,
      },
      {
        type: "operator",
        regex: /=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|[+\-*/%&|^!=<>?:]+/y,
      },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s]/y },
    ];
  }

  if (norm === "python") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /#.*/y },
      { type: "string", regex: /"""[\s\S]*?"""|'''[\s\S]*?'''|[furbFURB]*"(?:[^"\\]|\\.)*"|[furbFURB]*'(?:[^'\\]|\\.)*'/y },
      { type: "decorator", regex: /@[a-zA-Z_][a-zA-Z0-9_.]*/y },
      {
        type: "keyword",
        regex: /\b(?:def|class|import|from|as|return|if|elif|else|for|while|try|except|finally|with|lambda|yield|raise|pass|break|continue|global|nonlocal|assert|del|async|await|match|case|in|is|not|and|or)\b/y,
      },
      {
        type: "boolean",
        regex: /\b(?:True|False|None|self|cls)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:int|str|float|bool|list|dict|set|tuple|bytes|bytearray|range|enumerate|zip|map|filter|sum|min|max|len|sorted|print|open|isinstance|issubclass|type|super|id|repr|hasattr|getattr|setattr|delattr|Any|Optional|Union|List|Dict|Set|Tuple|Callable)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: "function", regex: /[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y },
      {
        type: "number",
        regex: /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b/y,
      },
      {
        type: "operator",
        regex: /==|!=|<=|>=|\/\/|\*\*|->|[+\-*/%&|^!=<>:]+/y,
      },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/y },
    ];
  }

  if (norm === "json") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "property", regex: /"(?:[^"\\]|\\.)*"(?=\s*:)/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"/y },
      { type: "number", regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
      { type: "boolean", regex: /\b(?:true|false|null)\b/y },
      { type: "punctuation", regex: /[{}()\[\]:,]/y },
      { type: "plain", regex: /[^\s]/y },
    ];
  }

  if (norm === "html" || norm === "xml") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /<!--[\s\S]*?-->/y },
      { type: "keyword", regex: /<!DOCTYPE[^>]*>/y },
      { type: "tag", regex: /<\/?([a-zA-Z0-9_:-]+)/y },
      { type: "attr-name", regex: /[a-zA-Z_:][a-zA-Z0-9_:-]*(?=\s*=)/y },
      { type: "attr-value", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y },
      { type: "keyword", regex: /&[a-zA-Z0-9#]+;/y },
      { type: "punctuation", regex: /[<>\/]/y },
      { type: "operator", regex: /=/y },
      { type: "plain", regex: /[^<\r\n]+/y },
    ];
  }

  if (norm === "css") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "keyword", regex: /@(media|keyframes|import|charset|font-face|supports|container|layer|page)\b/y },
      { type: "keyword", regex: /:(hover|active|focus|focus-visible|visited|disabled|first-child|last-child|before|after|has|not)\b/y },
      { type: "property", regex: /(--[a-zA-Z0-9_-]+|[a-zA-Z-]+)(?=\s*:)/y },
      { type: "function", regex: /\b(var|calc|rgb|rgba|hsl|hsla|color-mix|linear-gradient|radial-gradient|url|clamp|min|max)(?=\()/y },
      { type: "number", regex: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|vmin|vmax|pt|ch|ex|s|ms|deg|rad|turn|fr|cqw|cqh)\b|\b\d+\b/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y },
      { type: "keyword", regex: /\b(important|inherit|initial|unset|revert|auto|none|block|inline|flex|grid|absolute|relative|fixed|sticky|hidden|visible|center|left|right|top|bottom|cover|contain|nowrap|wrap|column|row|bold|normal|italic|transparent|currentColor)\b/y },
      { type: "punctuation", regex: /[{}()\[\];,:]/y },
      { type: "operator", regex: /[>+~*]/y },
      { type: "plain", regex: /[a-zA-Z0-9_.-]+|[^\s]/y },
    ];
  }

  if (norm === "rust") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "decorator", regex: /#\[[\s\S]*?\]/y },
      { type: "string", regex: /r#"[^"]*"#|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y },
      {
        type: "keyword",
        regex: /\b(?:fn|let|mut|pub|use|mod|struct|enum|trait|impl|type|where|for|while|loop|if|else|match|return|break|continue|async|await|unsafe|extern|const|static|crate|self|Self|super|as|in|ref|move|dyn)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Some|None|Ok|Err|Box|Rc|Arc|Cell|RefCell|Mutex|RwLock)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: "function", regex: /[a-zA-Z_][a-zA-Z0-9_]*!(?=\s*[\(\[{])|[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y },
      { type: "boolean", regex: /\b(?:true|false)\b/y },
      { type: "number", regex: /\b(?:0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?(?:[iuf]\d+|usize|isize)?)\b/y },
      { type: "operator", regex: /=>|->|::|==|!=|<=|>=|[+\-*/%&|^!=<>?:]+/y },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/y },
    ];
  }

  if (norm === "go") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "string", regex: /`[^`]*`|"(?:[^"\\]|\\.)*"/y },
      {
        type: "keyword",
        regex: /\b(?:package|import|func|type|struct|interface|var|const|return|if|else|for|range|switch|case|default|select|go|defer|break|continue|fallthrough|goto|map|chan)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|complex64|complex128|bool|byte|rune|error|any)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: "function", regex: /[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y },
      { type: "boolean", regex: /\b(?:true|false|nil|iota)\b/y },
      { type: "number", regex: /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?i?)\b/y },
      { type: "operator", regex: /:=|<-|==|!=|<=|>=|&&|\|\||[+\-*/%&|^!=<>:]+/y },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/y },
    ];
  }

  if (norm === "java") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "decorator", regex: /@[a-zA-Z_][a-zA-Z0-9_.]*/y },
      { type: "string", regex: /"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y },
      {
        type: "keyword",
        regex: /\b(?:package|import|public|private|protected|static|final|abstract|class|interface|enum|record|extends|implements|return|if|else|switch|case|break|continue|default|for|while|do|try|catch|finally|throw|throws|new|instanceof|this|super|synchronized|volatile|transient|native|strictfp|assert|yield|var|sealed|permits|non-sealed)\b/y,
      },
      {
        type: "boolean",
        regex: /\b(?:true|false|null)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:int|long|short|byte|float|double|boolean|char|void|String|Integer|Long|Boolean|Double|Float|Character|Byte|Short|Object|List|Map|Set|Optional|Collection|Arrays|Collections|Stream|CompletableFuture|Exception|RuntimeException|Throwable)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_$]*\b/y },
      { type: "function", regex: /[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()/y },
      {
        type: "number",
        regex: /\b(?:0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?[fFdDlL]?)\b/y,
      },
      {
        type: "operator",
        regex: /->|::|==|!=|<=|>=|&&|\|\||[+\-*/%&|^!=<>?:]+/y,
      },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s]/y },
    ];
  }

  if (norm === "c") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*/y },
      { type: "decorator", regex: /#[a-zA-Z_]+/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y },
      {
        type: "keyword",
        regex: /\b(?:int|char|float|double|void|long|short|unsigned|signed|const|static|extern|auto|register|volatile|struct|union|enum|typedef|sizeof|return|if|else|switch|case|break|continue|default|for|while|do|goto|template|typename|class|public|private|protected|virtual|override|constexpr|namespace|using)\b/y,
      },
      {
        type: "boolean",
        regex: /\b(?:true|false|NULL|nullptr)\b/y,
      },
      {
        type: "type",
        regex: /\b(?:size_t|ssize_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|bool|string|vector|map|set|unique_ptr|shared_ptr)\b/y,
      },
      { type: "type", regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: "function", regex: /[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/y },
      {
        type: "number",
        regex: /\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*)\b/y,
      },
      {
        type: "operator",
        regex: /->|::|==|!=|<=|>=|&&|\|\||[+\-*/%&|^!=<>?:]+/y,
      },
      { type: "punctuation", regex: /[{}()\[\];,.]/y },
      { type: "plain", regex: /[a-zA-Z_][a-zA-Z0-9_]*|[^\s]/y },
    ];
  }

  if (norm === "sql") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /--.*|\/\*[\s\S]*?\*\//y },
      { type: "string", regex: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/y },
      {
        type: "keyword",
        regex: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|EXISTS|IN|BETWEEN|LIKE|IS|NULL|NOT|AND|OR|AS|DISTINCT|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CHECK|DEFAULT|UNIQUE|CONSTRAINT|DATABASE|SCHEMA|CASCADE|TRANSACTION|COMMIT|ROLLBACK|GRANT|REVOKE|TRIGGER|PROCEDURE|FUNCTION|RETURNS|DECLARE|BEGIN|FETCH|CURSOR|OPEN|CLOSE|EXEC|EXECUTE)\b/iy,
      },
      {
        type: "type",
        regex: /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|VARCHAR|CHAR|TEXT|BOOLEAN|BOOL|DECIMAL|NUMERIC|FLOAT|REAL|DOUBLE|DATE|TIME|TIMESTAMP|DATETIME|JSON|JSONB|BLOB|UUID|SERIAL|BIGSERIAL)\b/iy,
      },
      { type: "function", regex: /\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NOW|CURRENT_TIMESTAMP|UPPER|LOWER|LENGTH|CONCAT|SUBSTRING|ROUND|CAST|EXTRACT)(?=\s*\()/iy },
      { type: "number", regex: /\b\d+(?:\.\d+)?\b/y },
      { type: "operator", regex: /<>|!=|<=|>=|[+\-*/%&|^!=<>:]+/y },
      { type: "punctuation", regex: /[()\[\],;.]/y },
      { type: "plain", regex: /[a-zA-Z0-9_]+|[^\s]/y },
    ];
  }

  if (norm === "bash") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /#.*/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"|'[^']*'/y },
      { type: "decorator", regex: /\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\}|\$[0-9@*#?$!-]/y },
      {
        type: "keyword",
        regex: /\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|export|source|alias|local|readonly|set|unset|shift|eval|exec)\b/y,
      },
      {
        type: "function",
        regex: /\b(?:echo|printf|cd|pwd|ls|cat|grep|sed|awk|cut|find|mkdir|rm|cp|mv|chmod|chown|touch|curl|wget|git|npm|node|npx|pnpm|yarn|docker|sudo|kill|ps|tar|zip|unzip)\b/y,
      },
      { type: "property", regex: /--[a-zA-Z0-9_-]+|-[a-zA-Z0-9]+/y },
      { type: "number", regex: /\b\d+\b/y },
      { type: "operator", regex: /&&|\|\||>>|>|<|\||==|!=|[+\-*/=]+/y },
      { type: "punctuation", regex: /[{}()\[\];,]/y },
      { type: "plain", regex: /[a-zA-Z0-9_.-]+|[^\s]/y },
    ];
  }

  if (norm === "yaml") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "comment", regex: /#.*|;.*/y },
      { type: "heading", regex: /^\[[^\]\r\n]+\]/y },
      { type: "property", regex: /^[ \t]*[a-zA-Z0-9_.-]+(?=\s*[=:])|[a-zA-Z0-9_.-]+(?=\s*:)/y },
      { type: "string", regex: /"(?:[^"\\]|\\.)*"|'[^']*'/y },
      { type: "boolean", regex: /\b(?:true|false|yes|no|on|off|null|~)\b/iy },
      { type: "number", regex: /\b\d+(?:\.\d+)?\b/y },
      { type: "operator", regex: /[-=:]+/y },
      { type: "punctuation", regex: /[{}()\[\],]/y },
      { type: "plain", regex: /[^\s]+/y },
    ];
  }

  if (norm === "markdown") {
    return [
      newlineRule,
      whitespaceRule,
      { type: "heading", regex: /^#{1,6}\s+[^\r\n]*/y },
      { type: "comment", regex: /^>[^\r\n]*/y },
      { type: "string", regex: /```[\s\S]*?```|`[^`\r\n]+`/y },
      { type: "link", regex: /\[[^\]\r\n]+\]\([^)\r\n]+\)/y },
      { type: "keyword", regex: /\*\*[^*]+?\*\*|__[^_]+?__/y },
      { type: "keyword", regex: /\*[^*]+?\*|_[^_]+?_/y },
      { type: "operator", regex: /^(\s*[-*+]|\s*\d+\.)\s+/y },
      { type: "plain", regex: /[^\r\n]+/y },
    ];
  }

  // Generic fallback
  return [
    newlineRule,
    whitespaceRule,
    { type: "comment", regex: /\/\*[\s\S]*?\*\/|\/\/.*|#.*/y },
    { type: "string", regex: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y },
    {
      type: "keyword",
      regex: /\b(?:import|export|from|function|class|const|let|var|return|if|else|for|while|try|catch|public|private|static|def|fn|package|struct)\b/y,
    },
    { type: "boolean", regex: /\b(?:true|false|null|nil|None)\b/y },
    { type: "number", regex: /\b\d+(?:\.\d+)?\b/y },
    { type: "operator", regex: /=>|==|!=|<=|>=|[+\-*/%&|^!=<>?:]+/y },
    { type: "punctuation", regex: /[{}()\[\];,.]/y },
    { type: "plain", regex: /[a-zA-Z0-9_$]+|[^\s]/y },
  ];
}

export function highlightCode(code: string, language: string): Token[][] {
  if (!code) return [[]];

  const rules = createRules(language);
  const resultLines: Token[][] = [[]];
  let currentLine = resultLines[0]!;

  let index = 0;
  const len = code.length;

  while (index < len) {
    let matched = false;

    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]!;
      rule.regex.lastIndex = index;
      const match = rule.regex.exec(code);

      if (match && match.index === index) {
        matched = true;
        const text = match[0];
        index += text.length;

        // Check if token spans multiple lines
        if (text.includes("\n")) {
          const parts = text.split(/\r?\n/);
          for (let p = 0; p < parts.length; p++) {
            if (p > 0) {
              const newLine: Token[] = [];
              resultLines.push(newLine);
              currentLine = newLine;
            }
            if (parts[p]!.length > 0) {
              currentLine.push({ type: rule.type, text: parts[p]! });
            }
          }
        } else if (text.length > 0) {
          currentLine.push({ type: rule.type, text });
        }
        break;
      }
    }

    if (!matched) {
      // Fallback single character
      const char = code[index]!;
      if (char === "\n") {
        const newLine: Token[] = [];
        resultLines.push(newLine);
        currentLine = newLine;
      } else if (char !== "\r") {
        currentLine.push({ type: "plain", text: char });
      }
      index++;
    }
  }

  return resultLines;
}
