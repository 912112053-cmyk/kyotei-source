/* ================================================================
   共テ (Kyotei web) — 変換ロジック共通モジュール
   ブラウザでは window.KyoteiConvert、Node では module.exports として使う。
   pdf.js / tesseract.js 本体には依存せず、それらの「出力オブジェクト」を
   受け取って処理する純粋関数群 + FlowBuilder + 解ける版HTML生成。
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

/* ================================================================
   テキスト層の items → 行
   ================================================================ */
function linesFromTextItems(items, pageW, pageH){
  if(!items.length) return { lines: [], words: [] };
  var heights = items.map(function(i){ return i.h; }).sort(function(a,b){ return a-b; });
  var medH = heights[Math.floor(heights.length / 2)] || 10;
  var sorted = items.slice().sort(function(a, b){ return b.y - a.y || a.x - b.x; }); /* 上の行から */
  var groups = [];
  sorted.forEach(function(it){
    var g = groups[groups.length - 1];
    if(g && Math.abs(it.y - g.y) <= 0.5 * medH){
      g.items.push(it);
    } else {
      groups.push({ y: it.y, items: [it] });
    }
  });
  var lines = [], words = [];
  groups.forEach(function(g){
    g.items.sort(function(a, b){ return a.x - b.x; });
    var minX = Math.min.apply(null, g.items.map(function(i){ return i.x; }));
    var maxX = Math.max.apply(null, g.items.map(function(i){ return i.x + i.w; }));
    var maxH = Math.max.apply(null, g.items.map(function(i){ return i.h; }));
    var text = g.items.map(function(i){ return i.str; }).join("");
    var top = (pageH - (g.y + maxH)) / pageH;
    lines.push({
      text: text,
      x: minX / pageW, y: top,
      width: (maxX - minX) / pageW, height: maxH / pageH
    });
    g.items.forEach(function(i){
      words.push({
        x0: i.x / pageW, y0: (pageH - (i.y + i.h)) / pageH,
        x1: (i.x + i.w) / pageW, y1: (pageH - i.y) / pageH
      });
    });
  });
  return { lines: lines, words: words };
}
function linesFromTextContent(tc, pageW, pageH){
  return linesFromTextItems(textItemsFromTextContent(tc), pageW, pageH);
}

/* ================================================================
   OCR (tesseract.js v5) の出力正規化
   必ず data.lines（真の行レベル）を使う。paragraphs / blocks を
   行として扱わない。words は data.words 優先、無ければ行内 words。
   返り値の lines は {text, x, y, width, height}（正規化座標, 左上原点）
   ================================================================ */
function normalizeOcrData(data, W, H){
  var lines = [], words = [];
  var srcLines = (data && data.lines) || [];
  srcLines.forEach(function(l){
    if(!l || !l.bbox) return;
    var text = (l.text || "").replace(/\s+$/g, "").replace(/^\s+/g, "");
    if(!text) return;
    lines.push({
      text: text,
      x: l.bbox.x0 / W, y: l.bbox.y0 / H,
      width: (l.bbox.x1 - l.bbox.x0) / W,
      height: (l.bbox.y1 - l.bbox.y0) / H
    });
    (l.words || []).forEach(function(w){
      if(w && w.bbox) words.push({ x0: w.bbox.x0 / W, y0: w.bbox.y0 / H, x1: w.bbox.x1 / W, y1: w.bbox.y1 / H });
    });
  });
  if(!words.length && data && data.words){
    data.words.forEach(function(w){
      if(w && w.bbox) words.push({ x0: w.bbox.x0 / W, y0: w.bbox.y0 / H, x1: w.bbox.x1 / W, y1: w.bbox.y1 / H });
    });
  }
  return { lines: lines, words: words };
}

/* worker.recognize を叩いて正規化済み {lines, words} を返す。
   image はブラウザでは canvas、Node ではファイルパス等（tesseract.js が受理する形式） */
async function ocrImage(worker, image, W, H){
  var result = await worker.recognize(image, {}, { blocks: true });
  return normalizeOcrData(result.data, W, H);
}

/* RGBA バッファ → グレースケール（図検出の入力。ブラウザの ImageData と
   Node の pngjs 出力はどちらも RGBA 並びなので共通で使える） */
function grayFromRGBA(d, W, H){
  var gray = new Uint8Array(W * H);
  for(var i = 0, j = 0; i < gray.length; i++, j += 4){
    gray[i] = (d[j] * 299 + d[j+1] * 587 + d[j+2] * 114) / 1000;
  }
  return gray;
}

/* ================================================================
   図バンド検出（検証済みパラメータをピクセル単位で実装）
   dark = gray < 210 / マスク = 単語ボックス +8px・+10px (200dpi換算)
   行アクティブ ≥0.4% / ギャップ結合 ≤1.8%H / GROW ≥0.1%（最大3%H）
   保持: 高さ ≥2%H / テキスト列での平均密度 ≥0.015 / 列トリム <1%
         幅 ≥10%W / 侵食後の内部密度 ≥0.01 / (高さ<3%H かつ 内部<0.10) は除外
   入力: gray (Uint8Array, W*H), W, H, wordBoxes（正規化座標）
   ================================================================ */
function detectFigureBands(gray, W, H, wordBoxes){
  if(W < 40 || H < 40 || !gray || gray.length < W * H) return [];
  /* テキストマスク */
  var mask = new Uint8Array(W * H);
  var padX = 8 * (W / 1432), padY = 10 * (H / 2026);
  wordBoxes.forEach(function(b){
    var x0 = Math.max(0, Math.floor(b.x0 * W - padX));
    var x1 = Math.min(W, Math.ceil(b.x1 * W + padX));
    var y0 = Math.max(0, Math.floor(b.y0 * H - padY));
    var y1 = Math.min(H, Math.ceil(b.y1 * H + padY));
    for(var y = y0; y < y1; y++){
      var off = y * W;
      for(var x = x0; x < x1; x++) mask[off + x] = 1;
    }
  });
  function isNTD(x, y){ var idx = y * W + x; return gray[idx] < 210 && !mask[idx]; }

  /* 行ごとの非テキスト暗ピクセル数 */
  var rowDark = new Float64Array(H);
  for(var y = 0; y < H; y++){
    var off = y * W, c = 0;
    for(var x = 0; x < W; x++){ var idx = off + x; if(gray[idx] < 210 && !mask[idx]) c++; }
    rowDark[y] = c;
  }
  var active = new Uint8Array(H);
  var actThresh = 0.004 * W;
  for(var y2 = 0; y2 < H; y2++) active[y2] = rowDark[y2] >= actThresh ? 1 : 0;
  /* ギャップ結合 */
  var maxGap = Math.round(0.018 * H);
  var scan = 0;
  while(scan < H){
    if(active[scan]){ scan++; continue; }
    var gapEnd = scan;
    while(gapEnd < H && !active[gapEnd]) gapEnd++;
    if(scan > 0 && gapEnd < H && gapEnd - scan <= maxGap){
      for(var r = scan; r < gapEnd; r++) active[r] = 1;
    }
    scan = gapEnd;
  }
  /* ラン収集 */
  var runs = [], runStart = -1;
  for(var y3 = 0; y3 < H; y3++){
    if(active[y3]){ if(runStart < 0) runStart = y3; }
    else if(runStart >= 0){ runs.push({ start: runStart, end: y3 }); runStart = -1; }
  }
  if(runStart >= 0) runs.push({ start: runStart, end: H });
  /* GROW: 隣接行が ≥0.1% なら上下へ伸ばす（最大 3%H） */
  var growThresh = 0.001 * W, maxGrow = Math.round(0.03 * H);
  runs.forEach(function(run){
    var n = 0;
    while(run.start > 0 && n < maxGrow && rowDark[run.start - 1] >= growThresh){ run.start--; n++; }
    n = 0;
    while(run.end < H && n < maxGrow && rowDark[run.end] >= growThresh){ run.end++; n++; }
  });
  /* 重なったランを統合 */
  runs.sort(function(a, b){ return a.start - b.start; });
  var merged = [];
  runs.forEach(function(run){
    var last = merged[merged.length - 1];
    if(last && run.start <= last.end){ last.end = Math.max(last.end, run.end); }
    else merged.push({ start: run.start, end: run.end });
  });
  /* テキスト列の範囲 */
  var colX0 = 0, colX1 = W;
  if(wordBoxes.length){
    var mn = Math.min.apply(null, wordBoxes.map(function(b){ return b.x0; }));
    var mx = Math.max.apply(null, wordBoxes.map(function(b){ return b.x1; }));
    colX0 = Math.max(0, Math.floor((mn - 0.02) * W));
    colX1 = Math.min(W, Math.ceil((mx + 0.02) * W));
  }
  var minBandH = 0.02 * H;
  var bands = [];
  merged.forEach(function(run){
    var rowCount = run.end - run.start;
    if(rowCount < minBandH || colX1 <= colX0) return;
    /* テキスト列での平均密度 */
    var dark = 0, total = 0;
    for(var ry = run.start; ry < run.end; ry++){
      for(var cx = colX0; cx < colX1; cx++){ total++; if(isNTD(cx, ry)) dark++; }
    }
    if(!total || dark / total < 0.015) return;
    /* 列トリム（密度 <1% の列を両端から） */
    function colDensity(cx){
      var dc = 0;
      for(var ry2 = run.start; ry2 < run.end; ry2++) if(isNTD(cx, ry2)) dc++;
      return dc / rowCount;
    }
    var c0 = colX0, c1 = colX1;
    while(c0 < c1 && colDensity(c0) < 0.01) c0++;
    while(c1 > c0 && colDensity(c1 - 1) < 0.01) c1--;
    if(c1 <= c0) return;
    if((c1 - c0) / W < 0.10) return;
    /* 侵食後の内部密度 */
    var er = Math.round(0.004 * W);
    var ix0 = c0 + er, ix1 = c1 - er, iy0 = run.start + er, iy1 = run.end - er;
    if(ix1 <= ix0 || iy1 <= iy0) return;
    var inDark = 0, inTotal = 0;
    for(var iy = iy0; iy < iy1; iy++){
      for(var ix = ix0; ix < ix1; ix++){ inTotal++; if(isNTD(ix, iy)) inDark++; }
    }
    if(!inTotal) return;
    var interior = inDark / inTotal;
    if(interior < 0.01) return;
    if(rowCount < 0.03 * H && interior < 0.10) return;
    bands.push({ xMin: c0 / W, yMin: run.start / H, xMax: c1 / W, yMax: run.end / H });
  });
  return bands;
}

/* バンドを切り取って JPEG data URL 化（ブラウザ専用。パディング = ページ高の1.5%） */
function cropBandToDataURL(canvas, band){
  var W = canvas.width, H = canvas.height;
  var padPx = 0.015 * H;
  var x = Math.max(0, band.xMin * W - padPx);
  var y = Math.max(0, band.yMin * H - padPx);
  var x2 = Math.min(W, band.xMax * W + padPx);
  var y2 = Math.min(H, band.yMax * H + padPx);
  var w = Math.floor(x2 - x), h = Math.floor(y2 - y);
  if(w < 8 || h < 8) return null;
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var cx = c.getContext("2d");
  cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, w, h);
  cx.drawImage(canvas, Math.floor(x), Math.floor(y), w, h, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.8);
}

/* ================================================================
   読順
   ================================================================ */
function readingOrder(lines){
  if(lines.length <= 1) return lines;
  var heights = lines.map(function(l){ return l.height; }).sort(function(a,b){ return a-b; });
  var medianHeight = heights[Math.floor(heights.length / 2)];
  function rowSorted(group){
    var byY = group.slice().sort(function(a, b){
      var ca = a.y + a.height / 2, cb = b.y + b.height / 2;
      if(ca !== cb) return ca - cb;
      return a.x - b.x;
    });
    var rows = [];
    byY.forEach(function(line){
      var center = line.y + line.height / 2;
      var lastRow = rows[rows.length - 1];
      if(lastRow && Math.abs(center - (lastRow[0].y + lastRow[0].height / 2)) <= 0.5 * medianHeight){
        lastRow.push(line);
      } else rows.push([line]);
    });
    var out = [];
    rows.forEach(function(r){
      r.sort(function(a, b){ return a.x - b.x; });
      r.forEach(function(l){ out.push(l); });
    });
    return out;
  }
  var centers = lines.map(function(l){ return l.x + l.width / 2; }).sort(function(a,b){ return a-b; });
  var splitX = null;
  if(centers.length >= 10){
    var widestGap = 0, widestMid = 0, widestIndex = 0;
    for(var i = 0; i < centers.length - 1; i++){
      var gap = centers[i+1] - centers[i];
      if(gap > widestGap){ widestGap = gap; widestMid = (centers[i] + centers[i+1]) / 2; widestIndex = i; }
    }
    var leftCount = widestIndex + 1, rightCount = centers.length - leftCount;
    if(widestGap > 0.15 && leftCount >= 5 && rightCount >= 5) splitX = widestMid;
  }
  if(splitX !== null){
    var left = lines.filter(function(l){ return l.x + l.width / 2 < splitX; });
    var right = lines.filter(function(l){ return l.x + l.width / 2 >= splitX; });
    return rowSorted(left).concat(rowSorted(right));
  }
  return rowSorted(lines);
}

/* 唯一、捨ててよい行: ページ上下端の単独ページ番号 */
function isNoiseLine(line){
  var text = line.text.replace(/^\s+|\s+$/g, "");
  if(!text || text.length > 8) return false;
  if(!/[0-9]/.test(text)) return false;
  if(!/^[0-9\-−–—― 　・\/]+$/.test(text)) return false;
  var centerY = line.y + line.height / 2;
  return centerY < 0.045 || centerY > 0.955;
}

var CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
var CIRCLED_MARKS = ["","①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩","⑪","⑫","⑬","⑭","⑮","⑯","⑰","⑱","⑲","⑳"];
var KATAKANA_LABELS = "アイウエオカキクケコサシスセソタチツテト";

/* 選択肢の開始行を検出（丸数字 / (1) / 1. 形式）。{value, text} か null */
function choiceStart(rawLine){
  var line = rawLine.replace(/^\s+|\s+$/g, "");
  if(!line) return null;
  var first = line.charAt(0);
  var ci = CIRCLED.indexOf(first);
  if(ci >= 0){
    var rest = line.slice(1).replace(/^\s+|\s+$/g, "");
    while(rest.length && "．.、：:".indexOf(rest.charAt(0)) >= 0){
      rest = rest.slice(1).replace(/^\s+|\s+$/g, "");
    }
    if(!rest || (rest.indexOf("のうちから") >= 0 && line.length <= 40)) return null;
    return { value: ci + 1, text: rest };
  }
  var m = line.match(/^[\(（]\s*([0-9０-９]{1,2})\s*[\)）]\s*(.*)$/);
  if(m){
    var v = parseInt(normalizeDigits(m[1]), 10);
    var rest2 = (m[2] || "").replace(/^\s+|\s+$/g, "");
    if(!(v >= 1 && v <= 20)) return null;
    if(!rest2 || (rest2.indexOf("のうちから") >= 0 && line.length <= 40)) return null;
    return { value: v, text: rest2 };
  }
  var m2 = line.match(/^([0-9０-９]{1,2})[.．、]\s*(.+)$/);
  if(m2){
    var v2 = parseInt(normalizeDigits(m2[1]), 10);
    var rest3 = (m2[2] || "").replace(/^\s+|\s+$/g, "");
    if(!(v2 >= 1 && v2 <= 20)) return null;
    if(!rest3 || (rest3.indexOf("のうちから") >= 0 && line.length <= 40)) return null;
    return { value: v2, text: rest3 };
  }
  return null;
}

function isQuestionHeader(text){
  var t = text.replace(/^\s+|\s+$/g, "");
  if(t.charAt(0) !== "第") return false;
  return t.slice(0, 8).indexOf("問") >= 0;
}
function endsSentence(text){
  if(!text) return true;
  return "。．！？」』）】".indexOf(text.charAt(text.length - 1)) >= 0;
}
function beginsParagraph(text){
  if(!text) return false;
  var first = text.charAt(0);
  if("第問・●○".indexOf(first) >= 0) return true;
  if(KATAKANA_LABELS.indexOf(first) >= 0 && text.length >= 2){
    var second = text.charAt(1);
    if("、：:・".indexOf(second) >= 0 || second === " " || second === "　") return true;
  }
  if(text.length === 1 && KATAKANA_LABELS.indexOf(first) >= 0) return true;
  return false;
}
/* 「問+数字」で始まる行か（設問の開始行アンカー） */
function isQuestionStartLine(text){
  return /^問\s*[0-9０-９]/.test(text.replace(/^\s+|\s+$/g, ""));
}

/* ================================================================
   FlowBuilder
   NO-DROP: 分類は「どう描くか」だけを決め、「描くかどうか」は決めない。
   すべての行は必ずどれか1つの要素として描かれる。
   ================================================================ */
function FlowBuilder(){
  this.elements = [];
  this.pendingParas = [];
  this.paraBuffer = "";
  this.paraPage = 0;
  this.openChoices = null;
  this.groupStem = [];
  this.groupPage = 0;
  this.choiceBaseX = 0;
}
FlowBuilder.prototype.flushParagraph = function(){
  if(!this.paraBuffer) return;
  this.pendingParas.push({ page: this.paraPage, text: this.paraBuffer });
  this.paraBuffer = "";
};
FlowBuilder.prototype.closeGroup = function(){
  if(this.openChoices === null) return;
  var choices = this.openChoices;
  this.openChoices = null;
  if(choices.length){
    this.elements.push({
      type: "question", page: this.groupPage,
      stem: this.groupStem.map(function(p){ return p.text; }),
      choices: choices
    });
  }
  this.groupStem = [];
};
FlowBuilder.prototype.addParagraphLine = function(line){
  if(!this.paraBuffer){
    this.paraBuffer = line.text; this.paraPage = line.page; return;
  }
  if(beginsParagraph(line.text) || endsSentence(this.paraBuffer)){
    this.flushParagraph();
    this.paraBuffer = line.text; this.paraPage = line.page;
  } else {
    this.paraBuffer += line.text;
  }
};
FlowBuilder.prototype.addChoice = function(text, line){
  if(this.openChoices === null || this.openChoices.length >= 10){
    this.closeGroup();
    this.flushParagraph();
    this.groupStem = this.pendingParas;
    this.pendingParas = [];
    this.groupPage = line.page;
    this.choiceBaseX = line.x;
    this.openChoices = [];
  }
  this.openChoices.push(text);
};
FlowBuilder.prototype.addLine = function(line){
  if(isQuestionHeader(line.text)){
    this.closeGroup();
    this.flushParagraph();
    this.paraBuffer = line.text;
    this.paraPage = line.page;
    this.flushParagraph();
    return;
  }
  var choice = choiceStart(line.text);
  if(choice){
    this.addChoice(choice.text, line);
    return;
  }
  if(this.openChoices !== null){
    /* 「問N」で始まる行は選択肢の続きではあり得ない。グループを閉じて題幹として扱う */
    if(isQuestionStartLine(line.text)){
      this.closeGroup();
      this.addParagraphLine(line);
      return;
    }
    if(line.x > this.choiceBaseX + 0.015 && this.openChoices.length){
      this.openChoices[this.openChoices.length - 1] += line.text;
      return;
    }
    this.closeGroup();
  }
  this.addParagraphLine(line);
};
FlowBuilder.prototype.addFigure = function(src, page){
  this.closeGroup();
  this.flushParagraph();
  var self = this;
  this.pendingParas.forEach(function(p){
    self.elements.push({ type: "paragraph", page: p.page, text: p.text });
  });
  this.pendingParas = [];
  this.elements.push({ type: "figure", page: page, src: src });
};
FlowBuilder.prototype.finish = function(){
  this.closeGroup();
  this.flushParagraph();
  var self = this;
  this.pendingParas.forEach(function(p){
    self.elements.push({ type: "paragraph", page: p.page, text: p.text });
  });
  this.pendingParas = [];
};

/* イベント列を FlowBuilder に流して要素列にする */
function runFlow(events){
  var b = new FlowBuilder();
  events.forEach(function(ev){
    if(ev.kind === "line") b.addLine(ev.line);
    else if(ev.kind === "figure") b.addFigure(ev.src, ev.page);
  });
  b.finish();
  return b.elements;
}
function countQuestions(elements){
  var n = 0;
  elements.forEach(function(e){ if(e.type === "question") n++; });
  return n;
}

/* 行末尾の独立した数字トークン（解答番号ボックスの番号）を返す。無ければ null */
function trailingNumber(text){
  var t = normalizeDigits(text);
  var m = t.match(/[0-9]{1,3}/g);
  if(!m) return null;
  var v = parseInt(m[m.length - 1], 10);
  return (v >= 1 && v <= 300) ? v : null;
}

/* ================================================================
   解答番号シーケンスによるアンカー分割
   題幹末尾の独立数字が 1,2,3,…,N と進むことを利用し、設問の切れ目を
   確定させる。FlowBuilder のグループ検出がキー数に届かない場合に使う。
   ================================================================ */
function segmentByAnchors(events, expectedCount){
  /* 行イベントだけを対象にアンカーを探す */
  var anchors = []; /* {k, evIdx} evIdx = アンカー行のイベント位置 */
  var pos = 0;      /* 探索開始イベント位置 */
  for(var k = 1; k <= expectedCount; k++){
    var found = -1;
    for(var i = pos; i < events.length; i++){
      var ev = events[i];
      if(ev.kind !== "line") continue;
      if(choiceStart(ev.line.text)) continue;
      if(trailingNumber(ev.line.text) !== k) continue;
      var t = ev.line.text;
      if(!(/選べ|うちから|組合せ|あてはまる|適切なもの/.test(t))) continue;
      /* 後方6行以内に選択肢行があること */
      var hasChoice = false, seen = 0;
      for(var j = i + 1; j < events.length && seen < 6; j++){
        if(events[j].kind !== "line") continue;
        seen++;
        if(choiceStart(events[j].line.text)){ hasChoice = true; break; }
      }
      if(!hasChoice) continue;
      found = i;
      break;
    }
    if(found < 0) continue; /* この番号は見つからない。pos は進めず次番号を探す */
    anchors.push({ k: k, evIdx: found });
    pos = found + 1;
  }
  if(anchors.length < Math.max(3, Math.ceil(expectedCount * 0.8))) return null;

  /* 各アンカーについて、後続の選択肢グループの終端イベント位置を求める */
  var segments = []; /* {start, end} イベント範囲 [start, end) */
  var segStart = 0;
  anchors.forEach(function(a){
    /* アンカー以降で最初の選択肢行 */
    var firstChoice = -1;
    for(var i = a.evIdx + 1; i < events.length; i++){
      if(events[i].kind === "line" && choiceStart(events[i].line.text)){ firstChoice = i; break; }
    }
    if(firstChoice < 0) return;
    var baseX = events[firstChoice].line.x;
    var end = firstChoice + 1;
    var nChoice = 1;
    for(var j = firstChoice + 1; j < events.length; j++){
      var ev = events[j];
      if(ev.kind !== "line") break;
      if(choiceStart(ev.line.text)){
        if(nChoice >= 12) break;
        nChoice++;
        end = j + 1;
        continue;
      }
      if(isQuestionStartLine(ev.line.text) || isQuestionHeader(ev.line.text)) break;
      if(ev.line.x > baseX + 0.015){ end = j + 1; continue; } /* 選択肢の続き行 */
      break;
    }
    segments.push({ start: segStart, end: end });
    segStart = end;
  });
  if(!segments.length) return null;

  /* セグメントごとに FlowBuilder で要素化。選択肢グループが取れなかった
     セグメントは、題幹だけの設問として補う（NO-DROP は維持） */
  var elements = [];
  function feedRange(from, to){
    var sub = runFlow(events.slice(from, to));
    sub.forEach(function(e){ elements.push(e); });
    return sub;
  }
  segments.forEach(function(seg, si){
    var before = elements.length;
    var sub = feedRange(seg.start, seg.end);
    var hasQ = sub.some(function(e){ return e.type === "question"; });
    if(!hasQ){
      /* 段落要素を題幹として設問化する */
      var stem = [];
      var rest = [];
      sub.forEach(function(e){
        if(e.type === "paragraph") stem.push(e.text);
        else rest.push(e);
      });
      var page = 0;
      for(var i = seg.start; i < seg.end; i++){
        if(events[i].kind === "line"){ page = events[i].line.page; break; }
      }
      elements.length = before;
      rest.forEach(function(e){ elements.push(e); });
      elements.push({ type: "question", page: page, stem: stem, choices: [] });
    }
    void si;
  });
  if(segStart < events.length) feedRange(segStart, events.length);
  return { elements: elements, questions: countQuestions(elements), method: "anchors", anchorsFound: anchors.length };
}

/* ================================================================
   断片設問の統合
   選択肢が表組み（複数列）で組まれている設問では、選択肢の行が
   検出から漏れてグループが途中で閉じ、1つの設問が複数の
   「設問要素」に分裂しやすい。分裂した断片は題幹に設問文
   （「…選べ」「うちから」「組合せ」）も「問N」の開始行も持たない。
   解答キーで設問数が分かっている場合は、その数まで断片を
   直前の設問へ統合する。断片の題幹段落は選択肢として付け足す
   （行は失われない = NO-DROP 維持）。
   ================================================================ */
function questionIsFragment(q){
  var stemAll = q.stem.join("");
  if(/選べ|うちから|組合せ/.test(stemAll)) return false;
  for(var i = 0; i < q.stem.length; i++){
    if(isQuestionStartLine(q.stem[i])) return false;
  }
  return true;
}
function mergeFragments(elements, targetCount){
  var els = elements.slice();
  function qIndices(){
    var idx = [];
    els.forEach(function(e, i){ if(e.type === "question") idx.push(i); });
    return idx;
  }
  while(true){
    var idxs = qIndices();
    if(targetCount > 0 && idxs.length <= targetCount) break;
    /* 最も断片らしい設問（選択肢が少ない順）を1つ選ぶ */
    var bestPos = -1, bestChoices = Infinity;
    for(var n = 0; n < idxs.length; n++){
      var q = els[idxs[n]];
      if(!questionIsFragment(q)) continue;
      if(targetCount <= 0 && q.choices.length > 1) continue;
      if(q.choices.length < bestChoices){ bestChoices = q.choices.length; bestPos = n; }
    }
    if(bestPos < 0) break;
    if(bestPos === 0) break; /* 先頭の設問は統合先がない */
    var fragIdx = idxs[bestPos];
    var prevIdx = idxs[bestPos - 1];
    var frag = els[fragIdx], prev = els[prevIdx];
    frag.stem.forEach(function(p){ if(p) prev.choices.push(p); });
    frag.choices.forEach(function(c){ prev.choices.push(c); });
    els.splice(fragIdx, 1);
  }
  return els;
}

/* ================================================================
   要素列の構築（入口）: events = [{kind:"line", line} | {kind:"figure", src, page}]
   expectedCount = 解答キーの設問数（0 ならアンカー分割は使わない）
   ================================================================ */
function buildElements(events, expectedCount){
  var base = runFlow(events);
  var q0 = countQuestions(base);
  if(expectedCount && expectedCount >= 4 && q0 > expectedCount){
    var merged = mergeFragments(base, expectedCount);
    return { elements: merged, questions: countQuestions(merged), method: "flow+merge" };
  }
  if(!expectedCount){
    var merged2 = mergeFragments(base, 0);
    return { elements: merged2, questions: countQuestions(merged2), method: "flow+merge" };
  }
  if(q0 >= expectedCount){
    return { elements: base, questions: q0, method: "flow" };
  }
  var anchored = segmentByAnchors(events, expectedCount);
  if(anchored && anchored.questions > q0){
    return anchored;
  }
  return { elements: base, questions: q0, method: "flow" };
}

/* 1ページ分の行イベントと図イベントを読み順に混ぜる（同yでは行が先） */
function mergePageEvents(lineEvents, figureEvents){
  var indexed = lineEvents.concat(figureEvents).map(function(ev, idx){ return { ev: ev, idx: idx }; });
  indexed.sort(function(a, b){
    if(Math.abs(a.ev.y - b.ev.y) > 0.0001) return a.ev.y - b.ev.y;
    var aFig = a.ev.kind === "figure" ? 1 : 0;
    var bFig = b.ev.kind === "figure" ? 1 : 0;
    if(aFig !== bFig) return aFig - bFig;
    return a.idx - b.idx;
  });
  return indexed.map(function(en){ return en.ev; });
}

/* ================================================================
   解ける版HTMLの生成
   templates = { css: "...", js: "..." }（__TITLE__ 等のプレースホルダを含む）
   ================================================================ */
function fullwidthNumber(n){
  return String(n).replace(/[0-9]/g, function(c){
    return String.fromCharCode(0xFF10 + (c.charCodeAt(0) - 0x30));
  });
}
function stemWithAnsBox(text, n){
  var variants = [String(n), fullwidthNumber(n)];
  var best = null;
  variants.forEach(function(variant){
    var from = 0;
    while(true){
      var idx = text.indexOf(variant, from);
      if(idx < 0) break;
      var beforeOK = idx === 0 || !/[0-9]/.test(text.charAt(idx - 1));
      var afterIdx = idx + variant.length;
      var afterOK = afterIdx >= text.length || !/[0-9]/.test(text.charAt(afterIdx));
      if(beforeOK && afterOK) best = { start: idx, end: afterIdx };
      from = idx + 1;
    }
  });
  if(!best) return esc(text) + ' <span class="ansbox" data-box="' + n + '">' + n + "</span>";
  return esc(text.slice(0, best.start))
    + '<span class="ansbox" data-box="' + n + '">' + esc(text.slice(best.start, best.end)) + "</span>"
    + esc(text.slice(best.end));
}

function buildHTML(title, elements, answerKey, points, storageKey, templates){
  var totalQuestions = 0;
  elements.forEach(function(e){ if(e.type === "question") totalQuestions++; });
  var totalPoints = 0;
  if(totalQuestions > 0){
    for(var n0 = 1; n0 <= totalQuestions; n0++) totalPoints += (points[n0] != null ? points[n0] : 1);
  }
  var body = "", questionNo = 0, currentSheetPage = null;
  function openSheet(page){
    if(currentSheetPage !== null) body += "</section>\n";
    currentSheetPage = page;
    body += '<section class="sheet" data-page="' + (page + 1) + '">\n';
    if(page > 0) body += '<div class="runhead">' + esc(title) + "</div>\n";
    if(page === 0){
      body += '<div class="bigtitle">\n<h1>' + esc(title) + "</h1>\n";
      if(totalQuestions > 0){
        body += '<div class="rng">（解答番号 <span class="ansbox">1</span> ～ <span class="ansbox">' + totalQuestions + "</span>）</div>\n";
      }
      body += "</div>\n";
    }
  }
  function ensureSheet(page){ if(currentSheetPage !== page) openSheet(page); }

  elements.forEach(function(element){
    if(element.type === "paragraph"){
      ensureSheet(element.page);
      body += "<p>" + esc(element.text) + "</p>\n";
    } else if(element.type === "figure"){
      ensureSheet(element.page);
      body += '<div class="fig"><img src="' + element.src + '" alt=""></div>\n';
    } else if(element.type === "question"){
      ensureSheet(element.page);
      questionNo += 1;
      var n = questionNo;
      body += '<div class="q" id="q' + n + '">\n';
      body += '<button class="flagbtn" data-flag="' + n + '">見直し</button>\n';
      if(!element.stem.length){
        body += '<p class="qstem"><span class="ansbox" data-box="' + n + '">' + n + "</span></p>\n";
      } else {
        element.stem.forEach(function(para, index){
          var cls = index === 0 ? ' class="qstem"' : "";
          if(index === element.stem.length - 1){
            body += "<p" + cls + ">" + stemWithAnsBox(para, n) + "</p>\n";
          } else {
            body += "<p" + cls + ">" + esc(para) + "</p>\n";
          }
        });
      }
      body += '<ul class="choices" data-q="' + n + '">\n';
      element.choices.forEach(function(choice, index){
        var v = index + 1;
        var mark = v < CIRCLED_MARKS.length ? CIRCLED_MARKS[v] : String(v);
        body += '<li><button data-v="' + v + '"><span class="mk">' + mark + "</span><span>" + esc(choice) + "</span></button></li>\n";
      });
      body += "</ul>\n";
      body += '<div class="expl" data-expl="' + n + '"></div>\n';
      body += "</div>\n";
    }
  });
  if(currentSheetPage !== null) body += "</section>\n";
  if(currentSheetPage === null){
    body = '<section class="sheet" data-page="1">\n<div class="bigtitle">\n<h1>' + esc(title)
      + "</h1>\n</div>\n<p>このPDFからはテキストを読み取れませんでした。</p>\n</section>\n";
  }
  var nav = "";
  if(totalQuestions > 0){
    nav = '<nav class="navrow">\n';
    for(var nn = 1; nn <= totalQuestions; nn++){
      nav += '<button data-jump="q' + nn + '">問' + nn + "</button>\n";
    }
    nav += "</nav>\n";
  }
  var ansJS = Object.keys(answerKey).sort(function(a,b){ return a-b; })
    .map(function(k){ return k + ":" + answerKey[k]; }).join(",");
  var ptsEntries = [];
  for(var pn = 1; pn <= totalQuestions; pn++) ptsEntries.push(pn + ":" + (points[pn] != null ? points[pn] : 1));
  var subText = totalQuestions > 0
    ? "全" + totalQuestions + "問・" + totalPoints + "点満点"
    : "問題を検出できませんでした";
  var css = (templates && templates.css || "").replace(/^\n+/, "");
  var script = (templates && templates.js || "").replace(/^\n+/, "");
  script = script.split("__TITLE__").join(JSON.stringify(title));
  script = script.split("__TOTAL__").join(String(totalQuestions));
  script = script.split("__ANS__").join(ansJS);
  script = script.split("__PTS__").join(ptsEntries.join(","));
  script = script.split("__STORAGE_KEY__").join(JSON.stringify(storageKey));

  return "<!doctype html>\n"
    + '<html lang="ja">\n<head>\n<meta charset="utf-8" />\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n'
    + '<meta name="color-scheme" content="light dark" />\n'
    + "<title>" + esc(title) + "（解ける版）</title>\n"
    + "<style>\n" + css + "\n</" + "style>\n</head>\n<body>\n"
    + '<header class="bar">\n  <div class="bar-in">\n    <div>\n'
    + '      <div class="ttl">' + esc(title) + "</div>\n"
    + '      <div class="sub">' + subText + "</div>\n    </div>\n"
    + '    <div class="timer" id="timer" title="経過時間">00:00</div>\n'
    + '    <div class="prog" id="prog">0 / ' + totalQuestions + ' 解答済み</div>\n'
    + '    <button class="btn" id="btnSheet">解答一覧</button>\n'
    + '    <button class="btn" id="btnPause">一時停止</button>\n'
    + '    <button class="btn" id="btnReset">リセット</button>\n'
    + '    <button class="btn" id="btnExport">解答を出力</button>\n'
    + '    <button class="btn solid" id="btnGrade">採点する</button>\n'
    + '    <button class="btn" id="btnHideBar">隠す</button>\n'
    + "  </div>\n" + nav + "</header>\n"
    + '<button id="barToggle">メニュー</button>\n'
    + '<main id="main">\n' + body + "</main>\n"
    + '<div class="overlay" id="overlay"><div class="panel" id="panel"></div></div>\n'
    + '<div class="toast" id="toast"></div>\n'
    + "<script>\n" + script + "\n</" + "script>\n</body>\n</html>";
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
  parseAnswerKeyFromPages: parseAnswerKeyFromPages,
  linesFromTextItems: linesFromTextItems,
  linesFromTextContent: linesFromTextContent,
  normalizeOcrData: normalizeOcrData,
  ocrImage: ocrImage,
  grayFromRGBA: grayFromRGBA,
  detectFigureBands: detectFigureBands,
  cropBandToDataURL: cropBandToDataURL,
  readingOrder: readingOrder,
  isNoiseLine: isNoiseLine,
  choiceStart: choiceStart,
  isQuestionHeader: isQuestionHeader,
  isQuestionStartLine: isQuestionStartLine,
  FlowBuilder: FlowBuilder,
  runFlow: runFlow,
  countQuestions: countQuestions,
  segmentByAnchors: segmentByAnchors,
  questionIsFragment: questionIsFragment,
  mergeFragments: mergeFragments,
  buildElements: buildElements,
  mergePageEvents: mergePageEvents,
  buildHTML: buildHTML
};

if(typeof module !== "undefined" && module.exports) module.exports = KyoteiConvert;
global.KyoteiConvert = KyoteiConvert;

})(typeof window !== "undefined" ? window : globalThis);
