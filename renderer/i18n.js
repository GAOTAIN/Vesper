// 本地语言表只用于应用文案；对话正文、输入值和模型标识不经过翻译。
(() => {
  const english = window.VesperEnglish;
  let language = 'zh-CN';
  const bindings = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement.closest('script,style') && /[\u3400-\u9fff]/.test(node.nodeValue)) {
      bindings.push({ node, original: node.nodeValue });
    }
  }
  for (const node of document.querySelectorAll('[title],[placeholder],[aria-label],[data-example]')) {
    for (const attribute of ['title', 'placeholder', 'aria-label', 'data-example']) {
      const original = node.getAttribute(attribute);
      if (original && /[\u3400-\u9fff]/.test(original)) bindings.push({ node, attribute, original });
    }
  }
  function t(key, values) {
    const original = String(key ?? '');
    const template = language === 'en' && Object.hasOwn(english, original) ? english[original] : original;
    // 一次替换，避免插入的用户文字或代码中的 {0} 再次被替换。
    return values ? template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match) : template;
  }
  // 主进程消息仍保留中文存储，通过同一张语言表按参数模式翻译展示。
  const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = Object.keys(english).filter(key => /\{\d+\}/.test(key) && !key.includes('<')).map(key => {
    const indices = [...key.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
    return { key, indices, regex: new RegExp('^' + key.split(/\{\d+\}/).map(escapeRegExp).join('([\\s\\S]*?)') + '$') };
  });
  function message(value) {
    const text = String(value ?? '');
    if (language !== 'en') return text;
    if (Object.hasOwn(english, text)) return t(text);
    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) { const values = []; pattern.indices.forEach((index, i) => { values[index] = match[i + 1]; }); return t(pattern.key, values); }
    }
    // 第三方服务及系统诊断原文不猜测翻译，保留定位故障需要的信息。
    return text;
  }
  function setLanguage(value) {
    language = value === 'en' ? 'en' : 'zh-CN';
    document.documentElement.lang = language;
    for (const binding of bindings) {
      if (!binding.node.isConnected) continue;
      const translated = t(binding.original.trim());
      const text = binding.original.replace(binding.original.trim(), translated);
      if (binding.attribute) binding.node.setAttribute(binding.attribute, text);
      else binding.node.nodeValue = text;
    }
  }
  window.VesperI18n = { t, message, setLanguage, get language() { return language; } };
})();
