// ============================================================
// Cubicase — Tutorial (menu lateral, busca e navegação entre artigos)
// ============================================================
// Cada <article class="tut-article" id="..." data-title="..." data-group="...">
// vira um item do menu lateral. A URL usa o hash (#criar-servidor), então dá pra
// linkar direto pra qualquer ensinamento. Sem JS, todos os artigos aparecem em
// sequência (a classe "js" só é ligada aqui).
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  var articles = Array.prototype.slice.call(document.querySelectorAll(".tut-article"));
  var nav = document.getElementById("tutNav");
  var sidebar = document.getElementById("tutSidebar");
  var menuBtn = document.getElementById("tutMenuBtn");
  var menuLabel = document.getElementById("tutMenuLabel");
  var search = document.getElementById("tutSearch");
  if (!articles.length || !nav) return;

  var byId = {};
  var links = {};
  var groups = [];
  var groupEls = {};

  function fold(s) {
    return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // ---- monta o menu lateral ----
  articles.forEach(function (art, idx) {
    byId[art.id] = art;
    var g = art.getAttribute("data-group") || "Geral";
    if (!groupEls[g]) {
      var wrap = document.createElement("div");
      wrap.className = "tut-group";
      var title = document.createElement("div");
      title.className = "tut-group-title";
      title.textContent = g;
      wrap.appendChild(title);
      nav.appendChild(wrap);
      groupEls[g] = wrap;
      groups.push(g);
    }
    var a = document.createElement("a");
    a.href = "#" + art.id;
    a.textContent = art.getAttribute("data-title") || art.id;
    a.setAttribute("data-search", fold((art.getAttribute("data-title") || "") + " " + art.textContent));
    groupEls[g].appendChild(a);
    links[art.id] = a;

    // Botões anterior / próximo no fim de cada artigo
    var prev = articles[idx - 1];
    var next = articles[idx + 1];
    var pager = document.createElement("div");
    pager.className = "tut-pager";
    pager.innerHTML =
      (prev ? '<a href="#' + prev.id + '"><small>← Anterior</small>' + prev.getAttribute("data-title") + "</a>" : '<a class="is-empty"></a>') +
      (next ? '<a class="is-next" href="#' + next.id + '"><small>Próximo →</small>' + next.getAttribute("data-title") + "</a>" : '<a class="is-empty"></a>');
    art.appendChild(pager);
  });

  var emptyMsg = document.createElement("div");
  emptyMsg.className = "tut-empty";
  emptyMsg.textContent = "Nada encontrado. Tente outra palavra.";
  emptyMsg.hidden = true;
  nav.appendChild(emptyMsg);

  // ---- navegação por hash ----
  var current = null;

  function show(id, keepScroll) {
    if (!byId[id]) id = articles[0].id;
    if (current === id) return;
    current = id;
    articles.forEach(function (a) { a.classList.toggle("is-current", a.id === id); });
    Object.keys(links).forEach(function (k) {
      links[k].classList.toggle("is-active", k === id);
      if (k === id) links[k].setAttribute("aria-current", "page");
      else links[k].removeAttribute("aria-current");
    });
    var title = byId[id].getAttribute("data-title");
    document.title = title + " — Tutorial do Cubicase";
    if (menuLabel) menuLabel.textContent = title;
    if (sidebar) sidebar.classList.remove("is-open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    if (!keepScroll) {
      var layout = document.querySelector(".tut-layout");
      if (layout) window.scrollTo({ top: Math.max(0, layout.offsetTop - 84), behavior: "auto" });
    }
  }

  function fromHash() {
    var id = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    show(id || articles[0].id, !id);
  }

  window.addEventListener("hashchange", fromHash);
  fromHash();

  // ---- busca ----
  if (search) {
    search.addEventListener("input", function () {
      var q = fold(search.value.trim());
      var any = false;
      groups.forEach(function (g) {
        var visible = 0;
        Array.prototype.forEach.call(groupEls[g].querySelectorAll("a"), function (a) {
          var ok = !q || a.getAttribute("data-search").indexOf(q) !== -1;
          a.hidden = !ok;
          if (ok) visible++;
        });
        groupEls[g].hidden = visible === 0;
        if (visible) any = true;
      });
      emptyMsg.hidden = any;
    });
    search.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var first = nav.querySelector("a:not([hidden])");
      if (first) location.hash = first.getAttribute("href");
    });
  }

  // ---- menu no celular ----
  if (menuBtn && sidebar) {
    menuBtn.addEventListener("click", function () {
      var open = sidebar.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
  }
})();
