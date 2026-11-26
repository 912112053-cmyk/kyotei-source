/* ================================================================
   共テ (Kyotei web) — 解答表パース専用モジュール (v11〜)
   ブラウザでは window.KyoteiConvert、Node では module.exports として使う。
   v11 で OCR 読み取り・構造化・解ける版HTML生成は廃止し、このファイルは
   解答PDFの正解・配点パース（幾何パース + 従来スキャン）だけを受け持つ。
   pdf.js 本体には依存せず、その「出力オブジェクト」を受け取って処理する。
   ================================================================ */
(function (global) {
"use strict";

/* ---------------- small helpers ---------------- */
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function normalizeDigits(s){
  return String(s).replace(/[０-９]/g, function(c){
    return String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30);
  });
}
function countJapanese(text){
  var m = String(text).match(/[぀-ゟ゠-ヿ一-鿿]/g);
  return m ? m.length : 0;
}

/* ================================================================
   解答表パース
   ================================================================ */
function tokenize(s){
  return normalizeDigits(s).split(/[^0-9]+/).filter(function(x){ return x.length; })
    .map(function(x){ return parseInt(x, 10); }).filter(function(x){ return !isNaN(x); });
}

/* 従来方式: 数字トークン列の逐次スキャン（幾何パースのフォールバック） */
function scanAnswerTokens(tokens){
  var key = {}, points = {};
  var expected = 1, i = 0;
  while(i < tokens.length){
    if(tokens[i] === expected){
      var j = i + 1;
      if(j < tokens.length && tokens[j] === expected) j += 1; /* 設問番号=解答番号の重複をスキップ */
      if(j < tokens.length && tokens[j] >= 1 && tokens[j] <= 9){
        key[expected] = tokens[j];
        if(j + 1 < tokens.length && tokens[j + 1] >= 1 && tokens[j + 1] <= 20){
          points[expected] = tokens[j + 1];
          i = j + 2;
        } else {
          i = j + 1;
        }
        expected += 1;
        continue;
      }
    }
    i += 1;
  }
  if(Object.keys(key).length >= 3) return { key: key, points: points };

  /* フォールバック: (設問番号, 解答番号, 正解, 配点) の4連続トークン */
  var pKey = {}, pPoints = {};
  for(var k = 0; k + 3 < tokens.length; k++){
    var sq = tokens[k], an = tokens[k+1], cor = tokens[k+2], pts = tokens[k+3];
    if(sq >= 1 && sq <= 20 && an >= 1 && an <= 300 && cor >= 1 && cor <= 9 &&
       pts >= 1 && pts <= 10 && pKey[an] == null){
      pKey[an] = cor; pPoints[an] = pts;
    }
  }
  return Object.keys(pKey).length > Object.keys(key).length
    ? { key: pKey, points: pPoints } : { key: key, points: points };
}

/* pdf.js の textContent から座標つき items を取り出す（ブラウザ/Node 共通） */
function textItemsFromTextContent(tc){
  var items = [];
  (tc.items || []).forEach(function(it){
    if(!it.str) return;
    var tr = it.transform || [1, 0, 0, 1, 0, 0];
    var h = it.height > 0 ? it.height : (Math.abs(tr[3]) || Math.abs(tr[0]) || 10);
    items.push({ str: it.str, x: tr[4], y: tr[5], w: it.width || 0, h: h });
  });
  return items;
}

/* pdf.js の doc から全ページの {width, height, items} を取り出す */
async function extractPdfPages(pdfjs, data){
  var doc = await pdfjs.getDocument({ data: data }).promise;
  var pages = [];
  try{
    for(var p = 1; p <= doc.numPages; p++){
      var page = await doc.getPage(p);
      var vp = page.getViewport({ scale: 1 });
      var tc = await page.getTextContent();
      pages.push({ width: vp.width, height: vp.height, items: textItemsFromTextContent(tc) });
    }
  } finally { doc.destroy(); }
  return pages;
}

/* ページ群 → 結合テキスト（従来スキャン用。items を stream 順に空白で連結） */
function answerJoinedText(pages){
  return pages.map(function(pg){
    return pg.items.map(function(it){ return it.str; }).join(" ");
  }).join(" ");
}

/* ================================================================
   解答表の幾何パース（本命）
   レイアウト: ページを左右2ブロックに分割。各ブロックの列は
   設問番号 | 解答番号 | 正解 | 配点。見出し行・セクション行
   （第N問・(配点) など）は数字だけの item を含まないので自然に落ちる。
   数字 item を集め、ブロック内で y 近接で行にまとめ、x 順に読む。
   有効な行 = 数字が4つ以上 [設問, 解答番号, 正解, 配点]。
   解答番号 → (正解, 配点) を登録する。
   ================================================================ */
function parseAnswerKeyGeometric(pages){
  var key = {}, points = {};
  pages.forEach(function(pg){
    var mid = pg.width / 2;
    var nums = [];
    pg.items.forEach(function(it){
      var t = normalizeDigits(String(it.str || "").replace(/^\s+|\s+$/g, ""));
      if(/^[0-9]+$/.test(t)){
        var v = parseInt(t, 10);
        if(v >= 1 && v <= 999){
          nums.push({ v: v, x: it.x, y: it.y, h: it.h || 10 });
        }
      }
    });
    if(!nums.length) return;
    var heights = nums.map(function(n){ return n.h; }).sort(function(a, b){ return a - b; });
    var medH = heights[Math.floor(heights.length / 2)] || 10;
    var tol = Math.max(2, 0.4 * medH);
    /* y の大きい順（ページ上部から）。pdf 座標は y-up */
    nums.sort(function(a, b){ return (b.y - a.y) || (a.x - b.x); });
    var rows = [];
    nums.forEach(function(n){
      var r = rows[rows.length - 1];
      if(r && Math.abs(r.y - n.y) <= tol) r.items.push(n);
      else rows.push({ y: n.y, items: [n] });
    });
    rows.forEach(function(r){
      var left = [], right = [];
      r.items.forEach(function(n){ (n.x < mid ? left : right).push(n); });
      [left, right].forEach(function(block){
        if(block.length < 4) return;
        block.sort(function(a, b){ return a.x - b.x; });
        var ansNo = block[1].v, cor = block[2].v, pts = block[3].v;
        if(ansNo >= 1 && ansNo <= 300 && cor >= 1 && cor <= 20 &&
           pts >= 1 && pts <= 30 && key[ansNo] == null){
          key[ansNo] = cor;
          points[ansNo] = pts;
        }
      });
    });
  });
  return { key: key, points: points, count: Object.keys(key).length };
}

/* 幾何パースの結果が「1..max の 90% 以上をカバー」しているか */
function keyCoverage(parsed){
  var ks = Object.keys(parsed.key).map(function(k){ return parseInt(k, 10); });
  if(!ks.length) return 0;
  var max = Math.max.apply(null, ks);
  return ks.length / max;
}

/* 解答キー取得の統合: 幾何パース優先、駄目なら従来スキャン */
function parseAnswerKeyFromPages(pages){
  var geo = parseAnswerKeyGeometric(pages);
  if(geo.count >= 3 && keyCoverage(geo) >= 0.9){
    return { key: geo.key, points: geo.points, count: geo.count, method: "geometric" };
  }
  var scanned = scanAnswerTokens(tokenize(answerJoinedText(pages)));
  var sCount = Object.keys(scanned.key).length;
  if(sCount > geo.count){
    return { key: scanned.key, points: scanned.points, count: sCount, method: "scan" };
  }
  return { key: geo.key, points: geo.points, count: geo.count, method: geo.count ? "geometric" : "none" };
}

var KyoteiConvert = {
  esc: esc,
  normalizeDigits: normalizeDigits,
  countJapanese: countJapanese,
  tokenize: tokenize,
  scanAnswerTokens: scanAnswerTokens,
  textItemsFromTextContent: textItemsFromTextContent,
  extractPdfPages: extractPdfPages,
  answerJoinedText: answerJoinedText,
  parseAnswerKeyGeometric: parseAnswerKeyGeometric,
  parseAnswerKeyFromPages: parseAnswerKeyFromPages
};

if(typeof module !== "undefined" && module.exports) module.exports = KyoteiConvert;
global.KyoteiConvert = KyoteiConvert;

})(typeof window !== "undefined" ? window : globalThis);
