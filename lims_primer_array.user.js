// ==UserScript==
// @name         [Custom] LIMS Primer Array 전체 기능 복구
// @namespace    http://tampermonkey.net/
// @version      20.4.9.0
// @description  프라이머 중복, 박스 요약, 코멘트 및 농도/사용횟수 강조, 접수 코멘트 표시, 공유 시트 스캔
// @match        https://lims3.macrogen.com/ces/order/retrieveArrayListForm.do*
// @match        https://lims3.macrogen.com/ces/order/retrieveArrayDetailForm.do*
// @run-at       document-idle
// @all_frames   true
// @grant        none
// @updateURL    https://raw.githubusercontent.com/garden-wq/lims-primer-mobile/main/lims_primer_array.user.js
// @downloadURL  https://raw.githubusercontent.com/garden-wq/lims-primer-mobile/main/lims_primer_array.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js#sha256=164fc2c1c9eaf0a03aa8dfdb855e82e41a5c6922fbad8bb3238116207e26bef7
// ==/UserScript==

(function() {
'use strict';

const LOCAL_STORAGE_KEY = 'lims_primer_array_v20_4_data';
const currentUrl = window.location.href;

// 강조 기준값: 기준을 바꾸려면 이 두 값만 수정
const USAGE_ALERT_MIN = 20; // 사용 횟수 이 값 이상이면 숫자 강조
const CONC_ALERT_OVER = 10; // 농도 0, 1 또는 이 값 초과면 강조

// 접수 코멘트 형식: 예) 11/05(143)재현
const RECEIPT_COMMENT_RE = /^\d{1,2}\/\d{1,2}\s*\(\s*\d+\s*\)/;
const ORDER_NO_RE = /^(HC\d+|[A-Z]{1,2}\d{6,10}|[A-Z]\d{6}-\d{3})$/i;

// GitHub Pages에 올린 핸드폰용 페이지 주소
const MOBILE_VIEWER_URL = 'https://garden-wq.github.io/lims-primer-mobile/';

const safeStorage = {
  getItem(key) {
    try { return window.localStorage.getItem(key); }
    catch (err) {
      console.warn('[LIMS] 저장소 읽기 제한:',err);
      return null;
    }
  },
  setItem(key,value) {
    try { window.localStorage.setItem(key,value); }
    catch(err) {
      console.warn('[LIMS] 저장소 쓰기 제한:',err);
    }
  }
};

function readSavedMap() {
  const raw = safeStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' &&
      !Array.isArray(obj) ? obj : {};
  } catch(err) {
    console.warn('[LIMS] 저장 데이터 형식 오류:',err);
    return {};
  }
}

console.info('[LIMS Primer Array] 전체 기능 복구 20.4.8.0 실행:',currentUrl);

const COLD_ROOM_PRIORITY = [
  "제작","P","K","H","A","B","C",
  "마크","수인성","박민영","국방부"
];

const MAIN_BOX_SERIES = ["제작","P","K","H","A","B","C"];

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

function getColdRoomPriorityIndex(boxName) {
  if(!boxName)return 999;
  const upper = boxName.toUpperCase();
  for(let i=0;i<COLD_ROOM_PRIORITY.length;i++){
    const key=COLD_ROOM_PRIORITY[i];
    if(upper.includes(key)||upper.startsWith(key))return i;
  }
  return 900;
}

function parseRxnSheetId(text) {
  if(!text)return null;
  const matched=text.trim().match(/H(\d{6})(-[A-Za-z0-9-]+)/i);
  if(matched){
    return {
      full:`H${matched[1]}${matched[2]}`.toUpperCase(),
      datePrefix:`H${matched[1]}`.toUpperCase(),
      suffix:matched[2].toUpperCase(),
      dateNum:parseInt(matched[1],10)
    };
  }
  return null;
}

function getMinSearchDateNum() {
  const dateInputs=document.querySelectorAll(
    'input[type="text"], input[class*="date"]'
  );
  for(const input of dateInputs){
    const val=input.value?input.value.trim():"";
    if(/^\d{4}[/.-]\d{2}[/.-]\d{2}$/.test(val) ||
       /^\d{8}$/.test(val)){
      const clean=val.replace(/[^0-9]/g,'');
      return parseInt(clean.substring(2),10);
    }
  }
  return 0;
}

function makeKey(custName,primerName) {
  const p=(primerName||"").replace(/\s+/g,'').toUpperCase();
  if(!p)return "";
  const c=(custName||"").replace(/\s+/g,'').toUpperCase();
  return c?`${c}${p}`:`ALL${p}`;
}

function extractCustNameFromTooltip(str) {
  if(!str)return "";
  const tokens=str.trim().split(/\s+/);
  const custTokens=[];
  tokens.forEach(token=>{
    if(!/^[A-Z]{1,2}\d{6,10}$|^[A-Z]\d{6}-\d{3}$/i.test(token) &&
       !/^HC\d+/i.test(token)){
      custTokens.push(token);
    }
  });
  return custTokens.join('');
}

function parseOrderAndCustInfo(str) {
  if(!str)return {orderNo:"",custName:"",fullText:"-"};
  const tokens=str.trim().split(/\s+/);
  let orderNo="";
  const custTokens=[];
  tokens.forEach(token=>{
    if(/^[A-Z]{1,2}\d{6,10}$|^[A-Z]\d{6}-\d{3}$/i.test(token) ||
       /^HC\d+/i.test(token)){
      if(!orderNo)orderNo=token;
    }else{
      custTokens.push(token);
    }
  });
  const custName=custTokens.join(' ');
  let fullText="-";
  if(orderNo&&custName)fullText=`[${orderNo}] ${custName}`;
  else if(custName)fullText=custName;
  else if(orderNo)fullText=orderNo;
  return {orderNo,custName,fullText};
}

function parsePrimerStatus(boxText) {
  if(!boxText)return "UNKNOWN";
  if(/Stored/i.test(boxText))return "STORED";
  if(/Enclosed/i.test(boxText))return "ENCLOSED";
  if(/Synthesis/i.test(boxText))return "SYNTHESIS";
  return "OTHER";
}

function isEligibleSharedGroup(entries) {
  if(!entries||entries.length<2)return false;
  const statuses=entries.map(e=>e.status||"UNKNOWN");
  return statuses.includes("STORED");
}

function removeUnnecessaryRxnCheckButtons() {
  const buttons=document.querySelectorAll(
    'button, a, input[type="button"]'
  );
  buttons.forEach(btn=>{
    const t=(btn.innerText||btn.value||"").trim();
    if(t.includes("RXN 체크 적용")||t.includes("RXN 체크적용")){
      btn.remove();
    }
  });
}

function extractPureBoxName(rawText,primerName="") {
  if(!rawText)return "";
  let cleanRaw=rawText.replace(/제직/g,'제작')
    .replace(/재작/g,'제작')
    .replace(/제쟉/g,'제작');
  const fullCheckText=`${cleanRaw} ${primerName}`;
  if(/Premix/i.test(fullCheckText) ||
     /\bEZ\d+/i.test(fullCheckText) ||
     /Standard/i.test(cleanRaw)){
    return "IS_EXCLUDED_PRIMER";
  }

  const rawLines=cleanRaw.split(/[\n\r]+|<br\s*\/?>/i)
    .map(l=>l.trim()).filter(Boolean);
  if(!rawLines.length)return "";

  const invalidTokens=[
    'STORED','SYNTHESIS','ENCLOSED','STANDARD',
    '양없음','스탁반송','스탁 반송','PREMIX',
    '마크보관','폐기'
  ];

  const hashLine=rawLines.find(line=>line.includes('#'));
  if(hashLine)return hashLine;
  const dashOneLine=rawLines.find(line=>line.startsWith('1-'));
  if(dashOneLine)return dashOneLine;

  const candidates=rawLines.filter(line=>{
    const upper=line.toUpperCase();
    if(/^\d{1,4}$/.test(line))return false;
    if(/^\d+\s*p$/i.test(line))return false;
    if(invalidTokens.includes(upper))return false;
    return true;
  });
  if(!candidates.length)return "";
  let targetBoxLine=candidates[candidates.length-1];
  if(/^[AR]$/i.test(targetBoxLine)){
    if(candidates.length>1){
      targetBoxLine=candidates[candidates.length-2];
    }else{
      return "";
    }
  }
  return targetBoxLine.replace(
    /^([0-9#가-힣A-Za-z-]+)\s+[AR]$/i,'$1'
  ).trim();
}

function parseBoxType(text) {
  if(!text)return null;
  let cleanText=text.trim().replace(/제직/g,'제작')
    .replace(/재작/g,'제작')
    .replace(/제쟉/g,'제작');

  if(/^\d+$/.test(cleanText)||/^\d+\s*p$/i.test(cleanText))
    return null;
  if([
    'Enclosed','Stored','Synthesis','Standard',
    '양없음','스탁반송','스탁 반송','Premix'
  ].includes(cleanText))return null;

  if(cleanText.includes('#'))return cleanText.split('#')[0];

  const match=cleanText.match(/^([A-Za-z0-9-]+|[가-힣]+)/);
  if(match){
    let name=match[0];
    if(/^\d+$/.test(name))return null;
    name=name.replace(/[AR]$/i,'');
    const alphaMatch=name.match(/^([A-Za-z-]+|[가-힣]+)/);
    return alphaMatch?alphaMatch[0]:name;
  }
  return null;
}

// ============================================================
// A. 목록 페이지
// ============================================================
if(currentUrl.includes('retrieveArrayListForm.do')) {
  console.info('[LIMS] 목록 화면 인식');

  const styleList=document.createElement('style');
  styleList.innerHTML=`
#lims-scan-panel {
 position:fixed;top:12px;left:50%;transform:translateX(-50%);
 z-index:999999;background:#fff;padding:10px 16px;
 border:2px solid #28a745;border-radius:8px;
 box-shadow:0 4px 15px rgba(0,0,0,.3);
 font-family:'Noto Sans KR',sans-serif;text-align:center;
 max-width:90vw;transition:all .3s ease;
}
#lims-scan-panel.warning {
 border-color:#fd7e14!important;background-color:#fff9db!important;
}
.scan-btn {
 padding:8px 14px;font-weight:bold;background-color:#28a745;
 color:white;border:none;border-radius:4px;cursor:pointer;
 font-size:13px;transition:all .2s;
}
.scan-btn:hover {background-color:#218838}
#scan-status {
 margin-top:6px;font-size:11.5px;color:#555;font-weight:bold;
}
#scan-status.green-text {color:#28a745!important}
#scan-status.orange-text {color:#e8590c!important}
`;
  document.head.appendChild(styleList);

  setInterval(()=>{
    try{
      if(document.querySelector('table')){
        initListScanUI();
        removeUnnecessaryRxnCheckButtons();
      }
    }catch(err){
      console.error('[LIMS] 목록 패널 생성 실패:',err);
    }
  },1000);

  function initListScanUI(){
    if(document.getElementById('lims-scan-panel'))return;
    const panel=document.createElement('div');
    panel.id='lims-scan-panel';
    panel.innerHTML=`
<div style="font-size:13px;font-weight:bold;margin-bottom:6px;color:#333">
📊 당일 Rxn Sheet 누적 공유 스캔
</div>
<button id="btn-start-scan" class="scan-btn">
🔍 당일 공유 프라이머 스캔
</button>
<div id="scan-status">대기 중...</div>
`;
    document.body.appendChild(panel);
    document.getElementById('btn-start-scan').onclick=executeCrossScan;

    const resultButton=document.createElement('button');
    resultButton.className='scan-btn';
    resultButton.textContent='📋 중복 결과 보기';
    resultButton.style.background='#087fbc';
    resultButton.onclick=showCrossScanResults;
    panel.insertBefore(resultButton,
      document.getElementById('scan-status'));
  }

  async function executeCrossScan(){
    const statusDiv=document.getElementById('scan-status');
    const panel=document.getElementById('lims-scan-panel');
    const targets=[];
    const scannedIds=new Set();

    panel.classList.remove('warning');
    statusDiv.className='';

    const minDateNum=getMinSearchDateNum();
    const gridContainer=document.querySelector(
      '.ui-jqgrid-bdiv, .k-grid-content, .table-responsive, body'
    );
    if(gridContainer){
      gridContainer.scrollTop=gridContainer.scrollHeight;
      await sleep(100);
      gridContainer.scrollTop=0;
    }

    const elements=document.querySelectorAll('table td a, table td');
    elements.forEach(el=>{
      const t=el.innerText||"";
      const parsed=parseRxnSheetId(t);
      if(parsed&&!scannedIds.has(parsed.full)){
        if(minDateNum===0||parsed.dateNum>=minDateNum){
          scannedIds.add(parsed.full);
          let href=el.getAttribute('href')||
            (el.querySelector('a')?
              el.querySelector('a').getAttribute('href'):'');
          let onclick=el.getAttribute('onclick')||
            (el.querySelector('a')?
              el.querySelector('a').getAttribute('onclick'):'');
          let targetUrl="";

          if(href&&href.includes('http')){
            targetUrl=href;
          }else if(href&&href.includes('.do')){
            targetUrl=window.location.origin+href;
          }else if(onclick){
            const match=onclick.match(
              /['"]([^'"]*\.do[^'"]*)['"]/
            );
            if(match)targetUrl=window.location.origin+match[1];
          }

          if(!targetUrl){
            targetUrl=`${window.location.origin}/ces/order/retrieveArrayDetailForm.do?rxnPlateId=${encodeURIComponent(parsed.full)}`;
          }
          try{
            targetUrl=new URL(targetUrl,location.origin).href;
          }catch{
            return;
          }
          if(new URL(targetUrl).origin!==location.origin)return;
          targets.push({info:parsed,url:targetUrl});
        }
      }
    });

    if(!targets.length){
      statusDiv.innerText="❌ 스캔할 Rxn Sheet가 없습니다.";
      return;
    }

    const primerSheetMap=readSavedMap();
    statusDiv.innerText=`⏳ 0 / ${targets.length} 순차 스캔 진행 중...`;
    let count=0;
    const skippedSheets=[];

    for(const item of targets){
      const sheetInfo=item.info;
      await sleep(120);
      const controller=new AbortController();
      const timeoutId=setTimeout(()=>controller.abort(),6000);
      try{
        const res=await fetch(item.url,{
          signal:controller.signal,
          credentials:'same-origin'
        });
        clearTimeout(timeoutId);
        if(!res.ok)throw new Error(`HTTP ${res.status}`);

        const html=await res.text();
        const doc=new DOMParser().parseFromString(html,'text/html');
        const sourceText=doc.body?
          (doc.body.innerText||doc.body.textContent||''):'';
        if(!sourceText.toUpperCase().includes(sheetInfo.full.toUpperCase())){
          throw new Error('응답에 요청한 Rxn Sheet ID가 없음 (조회 방식 확인 필요)');
        }

        const tables=doc.querySelectorAll('table.tbl_col.mb-32, table');
        const validTables=Array.from(tables).filter(
          table=>table.querySelectorAll('tr').length>=6
        );

        if(!validTables.length||
          /<form[^>]*login|로그인.*비밀번호/i.test(doc.body?.innerText||'')){
          throw new Error('유효한 시트 표 없음 (상세조회 주소/권한 확인 필요)');
        }

        Object.keys(primerSheetMap).forEach(key=>{
          if(!Array.isArray(primerSheetMap[key])){
            delete primerSheetMap[key];return;
          }
          primerSheetMap[key]=primerSheetMap[key].filter(
            s=>s.full!==sheetInfo.full
          );
          if(!primerSheetMap[key].length)delete primerSheetMap[key];
        });

        validTables.forEach(table=>{
          const rows=getRows(table);
          if(rows.length>=6){
            [
              [rows[1],rows[2],rows[3]],
              [rows[4],rows[5],rows[6]||rows[rows.length-1]]
            ].forEach(([nameRow,boxRow,checkRow])=>{
              if(nameRow&&checkRow){
                const nameCells=nameRow.querySelectorAll('td');
                const boxCells=boxRow?boxRow.querySelectorAll('td'):[];
                const checkCells=checkRow.querySelectorAll('td');
                let runningCustName="";

                for(let i=0;i<nameCells.length;i++){
                  const nameCell=nameCells[i];
                  const aTag=nameCell.querySelector('a');
                  let primerName=nameCell.innerText.trim();
                  const boxText=boxCells[i]?
                    boxCells[i].innerText.trim():"";
                  const status=parsePrimerStatus(boxText);

                  if(primerName.includes('\n')){
                    const lines=primerName.split('\n')
                      .map(l=>l.trim()).filter(Boolean);
                    primerName=lines[lines.length-1];
                  }

                  let foundCustName="";
                  if(aTag){
                    const rawTitle=aTag.getAttribute('title')||
                      aTag.getAttribute('data-original-title')||"";
                    foundCustName=extractCustNameFromTooltip(rawTitle);
                  }

                  if(!foundCustName&&checkCells[i]){
                    const badge=checkCells[i].querySelector(
                      '.cust-info-badge-cf'
                    );
                    const badgeText=badge?
                      badge.innerText:checkCells[i].innerText;
                    foundCustName=extractCustNameFromTooltip(badgeText);
                  }

                  if(foundCustName)runningCustName=foundCustName;

                  if(primerName&&!/Premix/i.test(primerName)&&
                     !/^EZ/i.test(primerName)){
                    const uniqueKey=makeKey(runningCustName,primerName);
                    if(uniqueKey){
                      if(!primerSheetMap[uniqueKey])
                        primerSheetMap[uniqueKey]=[];
                      const exists=primerSheetMap[uniqueKey].some(
                        s=>s.full===sheetInfo.full
                      );
                      if(!exists){
                        primerSheetMap[uniqueKey].push({
                          ...sheetInfo,status:status
                        });
                      }
                    }
                  }else if(!primerName){
                    runningCustName="";
                  }
                }
              }
            });
          }
        });
      }catch(e){
        console.warn(
          `[Skip 처리] ${sheetInfo.full} 건너뜀 (${e.message})`
        );
        skippedSheets.push(`${sheetInfo.full} (${e.message})`);
      }finally{
        clearTimeout(timeoutId);
      }
      count++;
      statusDiv.innerText=`⏳ ${count} / ${targets.length} 순차 스캔 진행 중...`;
    }

    safeStorage.setItem(
      LOCAL_STORAGE_KEY,JSON.stringify(primerSheetMap)
    );

    if(skippedSheets.length){
      panel.classList.add('warning');
      statusDiv.className='orange-text';
      statusDiv.innerText=
        `⚠️ 완료 (${targets.length-skippedSheets.length}/${targets.length} 성공, ${skippedSheets.length}개 스킵됨)`;
      alert(
        `⚠️ [스캔 완료 - 스킵 시트 존재]\n\n총 ${targets.length}개 중 ${skippedSheets.length}개 시트가 스킵되었습니다.\n\n[스킵된 시트 목록]:\n`+
        skippedSheets.join('\n')
      );
    }else{
      panel.classList.remove('warning');
      statusDiv.className='green-text';
      statusDiv.innerText=
        `✅ 전체 누적 스캔 완료 (${targets.length}개 100% 처리됨)`;
      alert(
        `✅ [스캔 완료]\n\n${targets.length}개 시트 100% 순차 스캔 완료!`
      );
    }
  }

  function showCrossScanResults(){
    const data=readSavedMap();
    const groups=Object.entries(data).filter(
      ([key,arr])=>Array.isArray(arr)&&
        new Set(arr.map(x=>x.full)).size>=2
    );
    groups.sort((a,b)=>b[1].length-a[1].length);

    document.getElementById('lims-cross-results')?.remove();
    const overlay=document.createElement('div');
    overlay.id='lims-cross-results';
    overlay.style.cssText=
      'position:fixed;inset:0;background:#0009;z-index:2147483647;display:flex;align-items:center;justify-content:center';

    const card=document.createElement('div');
    card.style.cssText=
      'background:#fff;max-height:85vh;overflow:auto;width:min(900px,95vw);padding:16px;border-radius:8px;font:13px Arial,sans-serif;color:#111';

    const title=document.createElement('h3');
    title.textContent=`중복 프라이머 분석 결과 (${groups.length}종)`;
    const close=document.createElement('button');
    close.textContent='닫기';
    close.onclick=()=>overlay.remove();
    const desc=document.createElement('p');
    desc.textContent=
      '서로 다른 Rxn Sheet 2개 이상에서 발견된 고객명 + 프라이머명 조합입니다. 스캔 실패/미조회 시트는 포함되지 않습니다.';
    card.append(title,close,desc);

    const table=document.createElement('table');
    table.style.cssText='width:100%;border-collapse:collapse';
    const header=table.createTHead().insertRow();
    ['고객+프라이머 키','발견 시트','시트 수','Stored 포함']
      .forEach(v=>{
        const th=document.createElement('th');
        th.textContent=v;
        th.style.cssText='border:1px solid #aaa;padding:7px';
        header.append(th);
      });

    const tbody=table.createTBody();
    groups.forEach(([key,arr])=>{
      const row=tbody.insertRow();
      const vals=[
        key,
        [...new Set(arr.map(x=>x.full))].join(', '),
        new Set(arr.map(x=>x.full)).size,
        arr.some(x=>x.status==='STORED')?'예':'아니오'
      ];
      vals.forEach(v=>{
        const td=row.insertCell();
        td.textContent=String(v);
        td.style.cssText='border:1px solid #aaa;padding:7px';
      });
    });
    card.append(table);
    if(!groups.length){
      const p=document.createElement('p');
      p.textContent=
        '현재 저장된 스캔 데이터에서 중복을 찾지 못했습니다.';
      card.append(p);
    }
    overlay.append(card);
    document.body.append(overlay);
    overlay.onclick=e=>{
      if(e.target===overlay)overlay.remove();
    };
  }
  return;
}

// ============================================================
// B. 상세 페이지 전용 로직
// ============================================================

const styleDetail=document.createElement('style');
styleDetail.innerHTML=`
#primer-box-filter-container {
 position:fixed;top:10px;left:50%;transform:translateX(-50%);
 z-index:999999;background:#fff;padding:8px 12px;
 border:2px solid #007bff;border-radius:8px;
 box-shadow:0 4px 15px rgba(0,0,0,.3);
 font-family:'Noto Sans KR',sans-serif;
 display:flex;align-items:center;gap:8px;
 max-width:95vw;box-sizing:border-box;
}
.filter-panel-left {
 display:flex;flex-direction:column;align-items:flex-start;width:100%;
}
.primer-filter-btn {
 margin:2px;padding:6px 10px;cursor:pointer;font-weight:bold;
 background:#007bff;color:white;border:0;border-radius:4px;
 font-size:12px;white-space:nowrap;
}
.primer-filter-btn:hover {background:#0056b3}
.primer-filter-btn.active {background:#28a745!important}
.primer-filter-btn.reset {background:#6c757d}
.primer-filter-btn.dup {background:#fd7e14}
.primer-filter-btn.dup:hover {background:#e8590c}
.primer-filter-btn.box-table-btn {background:#6f42c1}
.primer-filter-btn.box-table-btn:hover {background:#59359a}
.primer-filter-btn.mobile-qr-btn {background:#0064FF}
.primer-filter-btn.mobile-qr-btn:hover {background:#0050cc}
.primer-blanked {visibility:hidden!important}
.primer-highlight {
 background:#e8f4ff!important;font-weight:bold!important;
 color:#000!important;
}
.primer-duplicate {
 border:2.5px solid #fd7e14!important;font-weight:bold;
}
.dimmed-primer,.dimmed-primer * {
 color:#bbb!important;opacity:.5;font-weight:normal!important;
}
.shared-sheet-badge-day {
 display:block;font-size:10px;font-weight:bold;
 color:#d63384;background:#f8d7da;
 border:1px solid #f5c2c7;border-radius:4px;
 padding:2px 4px;margin-top:4px;text-align:center;
 white-space:nowrap;word-break:break-all;
 box-shadow:0 1px 3px rgba(0,0,0,.1);
}
.cust-info-badge-cf {
 display:block;font-size:10px;font-weight:bold;line-height:1.25;
 color:#0056b3;background:#e7f1ff;border:1px solid #b6d4fe;
 border-radius:3px;padding:3px 2px;margin-top:3px;
 text-align:center;white-space:normal;word-break:break-all;
}
.receipt-comment-badge {
 display:block;font-size:10px;font-weight:bold;line-height:1.25;
 color:#5c3d00;background:#fff3bf;border:1px solid #ffe066;
 border-radius:3px;padding:3px 2px;margin-top:3px;
 text-align:center;white-space:normal;word-break:break-all;
}
.comment-keyword-alert {
 background:#ffe3e3!important;color:#dc3545!important;
 font-weight:bold!important;
 border-left:4px solid #dc3545!important;
 padding-left:4px!important;border-radius:2px;
}
.num-red-bold-alert {
 color:#dc3545!important;font-weight:bold!important;
 font-size:1.1em!important;
}
.conc-alert-box {
 display:inline-block;min-width:22px;padding:0 4px;
 border:1.5px solid #333;border-radius:4px;
 background:#f1f3f5;color:#111;font-weight:800;line-height:1.4;
}
.usage-alert-box {
 color:#0064FF;font-weight:800;font-size:1.15em;
}
#box-summary-modal-overlay {
 position:fixed;top:0;left:0;width:100vw;height:100vh;
 background:rgba(0,0,0,.55);z-index:9999999;
 display:flex;justify-content:center;align-items:center;
 font-family:'Noto Sans KR',sans-serif;
}
.box-summary-modal-content {
 background:#fff;border-radius:12px;padding:18px;
 width:96vw;max-width:1050px;max-height:90vh;overflow-y:auto;
 box-shadow:0 12px 30px rgba(0,0,0,.35);
 border:2px solid #222;box-sizing:border-box;
}
.box-summary-modal-header {
 display:flex;justify-content:space-between;align-items:center;
 border-bottom:2px solid #111;padding-bottom:10px;
 margin-bottom:14px;
}
.box-summary-modal-title {
 font-size:16px;font-weight:bold;color:#111;line-height:1.3;
}
.box-summary-modal-close {
 background:#000;color:#fff;border:0;padding:6px 16px;
 border-radius:6px;cursor:pointer;font-weight:bold;
 font-size:13.5px;flex-shrink:0;
}
.box-summary-tables-wrapper {
 display:flex;gap:12px;align-items:flex-start;
 flex-wrap:wrap;width:100%;
}
.box-summary-modal-table {
 flex:1 1 290px;border-collapse:collapse;
 text-align:center;table-layout:fixed;min-width:280px;
}
.box-summary-modal-table th,.box-summary-modal-table td {
 border:1px solid #222;padding:6px 4px;
 vertical-align:middle;word-break:break-all;
}
.box-summary-modal-table th {
 background:#f8f9fa;font-weight:bold;font-size:12.5px;
}
.modal-primer-name-fixed {
 font-weight:800!important;font-size:13px!important;
 color:#111!important;
}
.box-summary-modal-table td.modal-cust-name {
 font-size:12.5px;font-weight:700;color:#111;line-height:1.3;
 word-break:keep-all;overflow-wrap:anywhere;
}
.box-summary-modal-actions {
 display:flex;gap:8px;flex-shrink:0;
}
.box-summary-modal-close.qr-btn {background:#0064FF}
#lims-mobile-qr-overlay {
 position:fixed;inset:0;background:rgba(0,0,0,.65);
 z-index:10000000;display:flex;justify-content:center;
 align-items:center;font-family:'Noto Sans KR',sans-serif;
}
.lims-mobile-qr-card {
 background:#fff;border-radius:12px;padding:16px;
 width:min(92vw,680px);max-height:96vh;overflow:auto;
 text-align:center;color:#111;box-sizing:border-box;
}
.lims-mobile-qr-code {
 width:min(72vh,100%);margin:10px auto;
}
.lims-mobile-qr-code svg {display:block;width:100%;height:auto}
.lims-mobile-qr-message {
 padding:28px 12px;font-size:14px;font-weight:bold;line-height:1.5;
}
`;
document.head.appendChild(styleDetail);

const FIXED_BOX_COLORS={
  C:{bg:"#ffe0e6",color:"#d63384"},
  H:{bg:"#e6f4ea",color:"#137333"},
  K:{bg:"#fff3cd",color:"#856404"},
  P:{bg:"#ffe8cc",color:"#e8590c"},
  A:{bg:"#e3faf8",color:"#121212"},
  B:{bg:"#f4fce3",color:"#5c940d"},
  "제작":{bg:"#f3d9fa",color:"#9c36b5"}
};
const ETC_BOX_COLOR={bg:"#e8e8ff",color:"#2b2b88"};

setInterval(function(){
  try{
    const tables=getArrayTables();
    const existingPanel=document.getElementById(
      'primer-box-filter-container'
    );
    if(!existingPanel||
      (existingPanel.dataset.limsNoTables==='1'&&tables.length)){
      if(existingPanel)existingPanel.remove();
      initFilterUI(tables);
    }
    if(!tables.length)return;
    highlightUpperCommentTableOnly();
    injectOrderInfoToCFRow(tables);
    highlightValidatedDuplicatePrimers(tables);
    highlightAlertNumbers(tables);
    removeUnnecessaryRxnCheckButtons();
  }catch(err){
    console.error('[LIMS] 상세 페이지 갱신 실패:',err);
  }
},1000);

function getRows(table){
  const bodyRows=Array.from(
    table?.querySelectorAll('tbody tr')||[]
  );
  return bodyRows.length?bodyRows:Array.from(
    table?.querySelectorAll('tr')||[]
  );
}

function getArrayTables(){
  function isDisplayed(el){
    if(!el||!el.isConnected||!el.getClientRects().length)
      return false;
    for(let node=el;node&&node.nodeType===1;
      node=node.parentElement){
      if(node.hidden||
        node.getAttribute('aria-hidden')==='true')
        return false;
      const cs=window.getComputedStyle(node);
      if(cs.display==='none'||
        cs.visibility==='hidden'||
        cs.visibility==='collapse')
        return false;
    }
    return true;
  }

  function isRealArrayGrid(table){
    if(!isDisplayed(table)||
       table.closest(
         '#box-summary-modal-overlay, #lims-cross-results'
       ))return false;
    const rows=getRows(table);
    if(rows.length<7)return false;

    const marker=row=>{
      const first=row?.querySelector('th,td');
      return (first?.innerText||first?.textContent||'')
        .trim().toUpperCase();
    };
    const labels=['A','B','C','D','E','F'];
    if(!labels.every((v,i)=>marker(rows[i+1])===v))
      return false;

    const links=
      rows[1].querySelectorAll('td a').length+
      rows[4].querySelectorAll('td a').length;
    return links>0;
  }

  return Array.from(
    document.querySelectorAll('table')
  ).filter(isRealArrayGrid);
}

function getFixedColorForBox(boxName){
  if(!boxName)return null;
  const upper=boxName.toUpperCase();
  if(FIXED_BOX_COLORS[upper])return FIXED_BOX_COLORS[upper];
  if(upper.includes('제작'))return FIXED_BOX_COLORS['제작'];
  const prefix=upper.charAt(0);
  if(FIXED_BOX_COLORS[prefix])return FIXED_BOX_COLORS[prefix];
  return ETC_BOX_COLOR;
}

function highlightUpperCommentTableOnly(){
  const targetKeywords=[
    '스탁 반송','스탁반송','새로 희석','새로희석',
    '이름주의','이름 주의','P반송','보관먼저사용','재희석'
  ];
  document.querySelectorAll('table').forEach(table=>{
    const headerText=table.innerText||"";
    if(headerText.includes('Ord. #')&&
       headerText.includes('Cust. Name')){
      table.querySelectorAll('tr').forEach(row=>{
        const t=row.innerText||"";
        if(targetKeywords.some(kw=>t.includes(kw))){
          row.querySelectorAll('td').forEach(cell=>{
            const ct=cell.innerText||"";
            if(targetKeywords.some(kw=>ct.includes(kw)))
              cell.classList.add('comment-keyword-alert');
          });
        }else{
          row.querySelectorAll('td').forEach(cell=>{
            const ct=(cell.innerText||"").trim();
            const upper=ct.toUpperCase();
            if(upper.startsWith('(S,P)')||
               upper.startsWith('S,P)')||
               upper.startsWith('(S, P)'))return;
            if(/^[*(]?P/i.test(ct))
              cell.classList.add('comment-keyword-alert');
          });
        }
      });
    }
  });
}

// ============================================================
// 배치표 통합 제어: 버튼 4개 표시
// ============================================================
function initFilterUI(tables){
  if(document.getElementById('primer-box-filter-container'))
    return;

  const container=document.createElement('div');
  container.id='primer-box-filter-container';
  container.dataset.limsNoTables=tables.length?'0':'1';

  const leftSide=document.createElement('div');
  leftSide.className='filter-panel-left';
  leftSide.innerHTML=`
<div style="margin-bottom:4px;font-size:12px;font-weight:bold;color:#333">
📦 배치표 통합 제어 (${tables.length}개 표)
</div>`;

  const btnWrapper=document.createElement('div');
  btnWrapper.style.display='flex';
  btnWrapper.style.alignItems='center';
  btnWrapper.style.flexWrap='wrap';

  const dupBtn=document.createElement('button');
  dupBtn.className='primer-filter-btn dup';
  dupBtn.innerText='⚠️ 중복감지';
  dupBtn.onclick=e=>{
    setActiveButton(e.target);
    filterDuplicatesOnly(getArrayTables());
  };
  btnWrapper.appendChild(dupBtn);

  const resetBtn=document.createElement('button');
  resetBtn.className='primer-filter-btn reset';
  resetBtn.innerText='🔄 전체';
  resetBtn.onclick=e=>{
    setActiveButton(e.target);
    resetAllTables();
  };
  btnWrapper.appendChild(resetBtn);

  const boxTableBtn=document.createElement('button');
  boxTableBtn.className='primer-filter-btn box-table-btn';
  boxTableBtn.innerText='📋 박스별 프라이머 목록 보기';
  boxTableBtn.onclick=()=>openBoxSummaryModal();
  btnWrapper.appendChild(boxTableBtn);

  const mobileQrBtn=document.createElement('button');
  mobileQrBtn.className='primer-filter-btn mobile-qr-btn';
  mobileQrBtn.innerText='📱 핸드폰 QR';
  mobileQrBtn.onclick=()=>{
    const {sheetTitle,itemList}=collectBoxSummary();
    openMobileQrOverlay(sheetTitle,itemList);
  };
  btnWrapper.appendChild(mobileQrBtn);

  leftSide.appendChild(btnWrapper);
  container.appendChild(leftSide);
  document.body.appendChild(container);
}

// 박스 요약과 핸드폰 QR이 같은 목록, 같은 동선 순서를 쓰도록 한곳에서 수집
function collectBoxSummary(){
  const pageText=document.body.innerText;
  const currentSheetMatch=pageText.match(
    /\[([A-Za-z0-9-]+)]/
  );
  const sheetTitle=currentSheetMatch?
    currentSheetMatch[1]:"Rxn Sheet";

  const itemList=[];
  getArrayTables().forEach(table=>{
    const rows=getRows(table);
    if(rows.length<6)return;
    processGroupForModal(
      rows[1],rows[2],rows[3],itemList
    );
    processGroupForModal(
      rows[4],rows[5],
      rows[6]||rows[rows.length-1],itemList
    );
  });

  itemList.sort((a,b)=>{
    const pA=getColdRoomPriorityIndex(a.boxName);
    const pB=getColdRoomPriorityIndex(b.boxName);
    if(pA!==pB)return pA-pB;
    return a.boxName.localeCompare(b.boxName,undefined,{
      numeric:true,sensitivity:'base'
    });
  });

  return {sheetTitle,itemList};
}

function openBoxSummaryModal(){
  if(document.getElementById('box-summary-modal-overlay'))
    return;

  const {sheetTitle,itemList}=collectBoxSummary();

  const overlay=document.createElement('div');
  overlay.id='box-summary-modal-overlay';

  if(!itemList.length){
    overlay.innerHTML=`
<div class="box-summary-modal-content"
 style="max-width:500px;text-align:center;padding:22px">
<div class="box-summary-modal-header">
<div class="box-summary-modal-title">
[${escapeHtml(sheetTitle)}] 박스 요약
</div>
<button class="box-summary-modal-close"
 id="btn-close-box-modal">닫기 X</button>
</div>
<div style="padding:40px 15px;font-size:15px;font-weight:bold;color:#333">
보관된 프라이머 박스 정보가 없습니다.
</div>
</div>`;
    document.body.appendChild(overlay);
    document.getElementById('btn-close-box-modal')
      .onclick=()=>overlay.remove();
    overlay.onclick=e=>{
      if(e.target===overlay)overlay.remove();
    };
    return;
  }

  const total=itemList.length;
  let numCols=1;
  if(total>20)numCols=3;
  else if(total>12)numCols=2;

  const itemsPerCol=Math.ceil(total/numCols);
  const chunks=[];
  for(let i=0;i<total;i+=itemsPerCol){
    chunks.push(itemList.slice(i,i+itemsPerCol));
  }

  let tablesHTML='';
  chunks.forEach(chunk=>{
    let rowsHTML='';
    chunk.forEach(item=>{
      const colorData=getFixedColorForBox(item.boxName);
      const styleAttr=colorData?
        `background-color:${colorData.bg}!important;color:${colorData.color}!important;font-weight:800;font-size:12.5px;`:
        'font-weight:800;font-size:12.5px;';
      const primerStyle=item.isDup?
        'border:2.5px solid #fd7e14!important;':'';
      const sharedBadge=item.sharedSuffix?
        `<span style="font-size:11px;color:#d63384;font-weight:bold;margin-left:4px">${escapeHtml(item.sharedSuffix)}</span>`:'';

      rowsHTML+=`
<tr>
<td class="modal-primer-name-fixed" style="${primerStyle}">
${escapeHtml(item.primerName)}${sharedBadge}
</td>
<td class="modal-cust-name">
${escapeHtml(item.custName)}
</td>
<td style="${styleAttr}">${escapeHtml(item.boxName)}</td>
</tr>`;
    });

    tablesHTML+=`
<table class="box-summary-modal-table">
<thead>
<tr>
<th style="width:36%">프라이머</th>
<th style="width:32%">고객명</th>
<th style="width:32%">박스 ▼</th>
</tr>
</thead>
<tbody>${rowsHTML}</tbody>
</table>`;
  });

  overlay.innerHTML=`
<div class="box-summary-modal-content">
<div class="box-summary-modal-header">
<div class="box-summary-modal-title">
[${escapeHtml(sheetTitle)}] 박스 요약 (스마트 다단 모드)
<div style="font-size:11.5px;color:#555;font-weight:normal">
(동선순 총 ${itemList.length}건 | 표 ${chunks.length}개 자동 균등 가로 배치)
</div>
</div>
<div class="box-summary-modal-actions">
<button class="box-summary-modal-close qr-btn"
 id="btn-open-mobile-qr">📱 핸드폰 QR</button>
<button class="box-summary-modal-close"
 id="btn-close-box-modal">닫기 X</button>
</div>
</div>
<div class="box-summary-tables-wrapper">
${tablesHTML}
</div>
</div>`;
  document.body.appendChild(overlay);

  document.getElementById('btn-open-mobile-qr')
    .onclick=()=>openMobileQrOverlay(sheetTitle,itemList);

  document.getElementById('btn-close-box-modal')
    .onclick=()=>overlay.remove();
  overlay.onclick=e=>{
    if(e.target===overlay)overlay.remove();
  };
}

// ============================================================
// 핸드폰 QR: 박스 요약 목록을 압축해 QR 주소의 # 뒤에 담음
// (# 뒤의 내용은 서버로 전송되지 않고 핸드폰 안에서만 읽힘)
// ============================================================
async function compressToBase64Url(text){
  const stream=new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const bytes=new Uint8Array(
    await new Response(stream).arrayBuffer()
  );
  let binary='';
  for(let i=0;i<bytes.length;i++){
    binary+=String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g,'-')
    .replace(/\//g,'_')
    .replace(/=+$/,'');
}

async function openMobileQrOverlay(sheetTitle,itemList){
  document.getElementById('lims-mobile-qr-overlay')?.remove();

  const overlay=document.createElement('div');
  overlay.id='lims-mobile-qr-overlay';
  const card=document.createElement('div');
  card.className='lims-mobile-qr-card';

  const title=document.createElement('div');
  title.style.cssText='font-size:16px;font-weight:bold';
  title.textContent=
    `[${sheetTitle}] 프라이머 ${itemList.length}건`;

  const content=document.createElement('div');
  const closeBtn=document.createElement('button');
  closeBtn.className='box-summary-modal-close';
  closeBtn.textContent='닫기 X';
  closeBtn.onclick=()=>overlay.remove();

  card.append(title,content,closeBtn);
  overlay.append(card);
  document.body.append(overlay);
  overlay.onclick=e=>{
    if(e.target===overlay)overlay.remove();
  };

  const showMessage=text=>{
    const message=document.createElement('div');
    message.className='lims-mobile-qr-message';
    message.textContent=text;
    content.replaceChildren(message);
  };

  if(!itemList.length){
    showMessage('보관된 프라이머 박스 정보가 없습니다.');
    return;
  }
  if(typeof qrcode!=='function'){
    showMessage('QR 라이브러리를 불러오지 못했습니다. 템퍼몽키에서 스크립트를 다시 저장한 뒤 새로고침해 주세요.');
    return;
  }

  try{
    const payload={
      v:1,
      s:sheetTitle,
      i:itemList.map(x=>[x.primerName,x.custName,x.boxName])
    };
    const encoded=await compressToBase64Url(
      JSON.stringify(payload)
    );
    const url=`${MOBILE_VIEWER_URL}#d=${encoded}`;

    const qr=qrcode(0,'L');
    qr.addData(url,'Byte');
    qr.make();

    const code=document.createElement('div');
    code.className='lims-mobile-qr-code';
    code.innerHTML=qr.createSvgTag({
      cellSize:4,margin:16,scalable:true
    });

    const help=document.createElement('div');
    help.style.cssText='font-size:13px;margin-bottom:10px';
    help.textContent='핸드폰 카메라로 찍으면 목록이 열립니다. ';
    const link=document.createElement('a');
    link.id='lims-mobile-qr-link';
    link.href=url;
    link.target='_blank';
    link.rel='noopener noreferrer';
    link.textContent='PC에서 미리 보기';
    help.append(link);

    content.replaceChildren(code,help);
  }catch(err){
    console.error('[LIMS] QR 생성 실패:',err);
    showMessage('QR을 만들지 못했습니다. 프라이머 수가 많아 QR 용량을 넘었거나 브라우저가 압축 기능을 지원하지 않습니다.');
  }
}

function fallbackCollectFromBadgesAndComments(tables){
  const fallbackList=[];
  tables.forEach(table=>{
    const badges=table.querySelectorAll('.cust-info-badge-cf');
    badges.forEach(badge=>{
      const parts=badge.innerText.split('\n')
        .map(l=>l.trim()).filter(Boolean);
      const custName=parts.length>1?parts[1]:parts[0];
      const parentTd=badge.closest('td');
      if(parentTd){
        parentTd.querySelectorAll('a').forEach(link=>{
          const title=link.getAttribute('title')||
            link.getAttribute('data-original-title')||
            link.innerText.trim();
          if(title&&!/Premix/i.test(title)){
            const matchBox=title.match(
              /([A-Z0-9#-가-힣]+)/g
            );
            const boxName=matchBox?
              matchBox[matchBox.length-1]:"Stored";
            fallbackList.push({
              primerName:link.innerText.trim()||"Stored Primer",
              custName:custName||"-",
              boxName,
              isDup:false,
              sharedSuffix:""
            });
          }
        });
      }
    });
  });
  return fallbackList;
}

// 실제 어레이에 있는 프라이머 링크만 박스 요약에 추가
function processGroupForModal(nameRow,boxRow,checkRow,itemList){
  if(!nameRow||!boxRow)return;

  const nameCells=Array.from(nameRow.querySelectorAll('td'));
  const boxCells=Array.from(boxRow.querySelectorAll('td'));
  const checkCells=Array.from(
    checkRow?.querySelectorAll('td')||[]
  );

  let runningCustName='';

  for(let i=0;i<nameCells.length;i++){
    const cell=nameCells[i];
    const link=cell.querySelector('a');

    if(!link){
      if(!cell.innerText.trim())runningCustName='';
      continue;
    }

    const primerName=(link.innerText||link.textContent||'')
      .trim();
    const rawBoxText=(boxCells[i]?.innerText||'').trim();

    if(!primerName||!rawBoxText)continue;

    const info=parseOrderAndCustInfo(
      link.getAttribute('title')||
      link.getAttribute('data-original-title')||''
    );
    if(info.custName)runningCustName=info.custName;

    const badge=checkCells[i]?.querySelector(
      '.cust-info-badge-cf'
    );
    if(badge){
      const parsed=parseOrderAndCustInfo(badge.innerText);
      if(parsed.custName)runningCustName=parsed.custName;
    }

    // Synthesis 항목도 실제 제작 박스가 있으면 포함
    const pureBox=extractPureBoxName(
      rawBoxText,primerName
    );
    if(!pureBox||pureBox==='IS_EXCLUDED_PRIMER')
      continue;

    const shared=cell.querySelector(
      '.shared-sheet-badge-day'
    );

    itemList.push({
      primerName,
      custName:runningCustName||'-',
      boxName:pureBox,
      isDup:cell.classList.contains('primer-duplicate'),
      sharedSuffix:shared?shared.innerText.trim():''
    });
  }
}

function generateUnifiedColorDocument(tables){
  let hasValidBoxData=false;

  tables.forEach(table=>{
    const rows=getRows(table);
    if(rows.length>=6){
      [rows[2],rows[5]].forEach(boxRow=>{
        if(!boxRow)return;
        boxRow.querySelectorAll('td').forEach(cell=>{
          const pure=extractPureBoxName(cell.innerText);
          if(pure&&pure!=='IS_EXCLUDED_PRIMER')
            hasValidBoxData=true;
        });
      });
    }
  });

  if(!hasValidBoxData||!tables.length){
    alert('보관된 프라이머 박스 정보가 없습니다.');
    return;
  }

  const pageText=document.body.innerText;
  const currentSheetMatch=pageText.match(
    /\[([A-Za-z0-9-]+)]/
  );
  const sheetTitle=currentSheetMatch?
    currentSheetMatch[1]:'Rxn Sheet';

  const detectedBoxes=scanAllAvailableBoxes(tables);
  const printWindow=window.open('','_blank');

  if(!printWindow){
    alert('팝업 창이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
    return;
  }

  let legendHTML='';
  let hasEtcSeries=false;

  detectedBoxes.forEach(boxName=>{
    if(MAIN_BOX_SERIES.includes(boxName)){
      const c=getFixedColorForBox(boxName);
      legendHTML+=`
<span class="legend-item"
 style="background-color:${c.bg}!important;color:${c.color}!important;font-weight:bold">
${escapeHtml(boxName)} 시리즈
</span>`;
    }else{
      hasEtcSeries=true;
    }
  });

  if(hasEtcSeries){
    legendHTML+=`
<span class="legend-item"
 style="background-color:${ETC_BOX_COLOR.bg}!important;color:${ETC_BOX_COLOR.color}!important">
기타 박스 시리즈
</span>`;
  }

  legendHTML+=`
<span class="legend-item"
 style="border:2.5px solid #fd7e14!important">
⚠️ 동일시트 중복
</span>`;

  let fullHTML=`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(sheetTitle)} 박스 색상 요약</title>
<style>
body {
 font-family:'Noto Sans KR',sans-serif;
 padding:20px;color:#333;background:#f9f9f9;
}
.page-section {
 background:white;padding:20px;border-radius:8px;
 margin-bottom:20px;
}
.legend {
 display:flex;gap:10px;margin-bottom:15px;
 flex-wrap:wrap;font-size:12px;
}
.legend-item {
 padding:5px 10px;border:1px solid #ccc;border-radius:4px;
}
table {
 width:100%;border-collapse:collapse;
 margin-bottom:20px;font-size:11px;
}
th,td {
 border:1px solid #ccc;padding:6px;
 text-align:center;vertical-align:middle;
}
th {background:#f2f2f2}
.primer-duplicate {
 border:2.5px solid #fd7e14!important;font-weight:bold;
}
.shared-sheet-badge-day {
 color:#d63384;font-weight:bold;font-size:10px;
}
.cust-info-badge-cf {
 color:#0056b3;font-weight:bold;font-size:10px;
}
@media print {
 .no-print {display:none}
 body {padding:0;background:white}
 * {-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>
</head>
<body>
<div class="no-print" style="text-align:center;margin-bottom:20px">
<button onclick="window.print()">
🖨️ PDF 저장 / 인쇄
</button>
</div>
<h2 style="text-align:center">
시트 ID: ${escapeHtml(sheetTitle)} (박스 색상 구분)
</h2>
<div class="legend">${legendHTML}</div>
<div class="page-section">
`;

  tables.forEach((table,index)=>{
    const clone=table.cloneNode(true);
    clone.querySelectorAll('input[type="checkbox"]')
      .forEach(cb=>cb.remove());

    const origRows=table.querySelectorAll('tbody tr');
    const clonedRows=clone.querySelectorAll('tbody tr');

    if(origRows.length>=6){
      for(const [nameIndex,boxIndex] of [[1,2],[4,5]]){
        const origNames=origRows[nameIndex].querySelectorAll('td');
        const origBoxes=origRows[boxIndex].querySelectorAll('td');
        const newNames=clonedRows[nameIndex].querySelectorAll('td');
        const newBoxes=clonedRows[boxIndex].querySelectorAll('td');

        for(let i=0;i<newBoxes.length;i++){
          if(!newNames[i])continue;

          const rawName=origNames[i]?.innerText||'';
          const pureBox=extractPureBoxName(
            origBoxes[i]?.innerText||'',rawName
          );

          if(pureBox==='IS_EXCLUDED_PRIMER'){
            newBoxes[i].textContent='';
            continue;
          }

          newBoxes[i].textContent=pureBox||'';

          const isDup=origNames[i]?.classList.contains(
            'primer-duplicate'
          );
          if(isDup){
            newNames[i].style.border='2.5px solid #fd7e14';
          }

          if(pureBox){
            const matched=findMatchedBoxInList(
              pureBox,detectedBoxes
            );
            const c=getFixedColorForBox(
              matched||pureBox
            );
            if(c){
              for(const cell of [newNames[i],newBoxes[i]]){
                cell.style.backgroundColor=c.bg;
                cell.style.color=c.color;
                cell.style.fontWeight='bold';
              }
            }
          }else{
            newNames[i].style.backgroundColor='#fff';
            newBoxes[i].style.backgroundColor='#fff';
          }
        }
      }
    }

    fullHTML+=`
<div style="font-weight:bold;margin-bottom:5px">
Table #${index+1}
</div>${clone.outerHTML}`;
  });

  fullHTML+='</div></body></html>';
  printWindow.document.write(fullHTML);
  printWindow.document.close();
}

function findMatchedBoxInList(pureText,detectedBoxes){
  if(!pureText)return null;
  for(const box of detectedBoxes){
    if(pureText.includes(box))return box;
  }
  return pureText;
}

// ============================================================
// 접수 코멘트: 상단 코멘트 표에서 주문번호별로 수집
// ============================================================
function buildOrderCommentMap(){
  const map=new Map();

  document.querySelectorAll('table').forEach(table=>{
    if(table.closest(
      '#box-summary-modal-overlay, #lims-cross-results'
    ))return;

    const headerText=table.innerText||'';
    if(!headerText.includes('Ord. #')||
       !headerText.includes('Cust. Name'))return;

    let currentOrder='';
    table.querySelectorAll('tr').forEach(row=>{
      const cells=Array.from(row.querySelectorAll('td'));

      cells.forEach(cell=>{
        const text=(cell.innerText||'').trim();
        if(ORDER_NO_RE.test(text))
          currentOrder=text.toUpperCase();
      });
      if(!currentOrder)return;

      cells.forEach(cell=>{
        (cell.innerText||'').split('\n')
          .map(l=>l.trim())
          .filter(l=>RECEIPT_COMMENT_RE.test(l))
          .forEach(line=>{
            if(!map.has(currentOrder))map.set(currentOrder,[]);
            const list=map.get(currentOrder);
            if(!list.includes(line))list.push(line);
          });
      });
    });
  });

  return map;
}

function upsertReceiptCommentBadge(cell,link,comments){
  const key=comments.join('|');
  let badge=cell.querySelector('.receipt-comment-badge');
  if(badge&&badge.dataset.limsComment===key)return;

  if(!badge){
    badge=document.createElement('div');
    badge.className='receipt-comment-badge';
    link.insertAdjacentElement('afterend',badge);
  }
  badge.dataset.limsComment=key;
  badge.innerHTML=
    comments.map(c=>`<div>${escapeHtml(c)}</div>`).join('');
}

function injectOrderInfoToCFRow(tables){
  const orderCommentMap=buildOrderCommentMap();

  tables.forEach(table=>{
    const rows=getRows(table);
    if(rows.length<6)return;
    processGroupCFByBlocks(rows[1],rows[3],orderCommentMap);
    if(rows[4]&&(rows[6]||rows[rows.length-1])){
      processGroupCFByBlocks(
        rows[4],rows[6]||rows[rows.length-1],orderCommentMap
      );
    }
  });
}

function processGroupCFByBlocks(nameRow,checkRow,orderCommentMap){
  if(!nameRow||!checkRow)return;
  const nameCells=nameRow.querySelectorAll('td');
  const checkCells=checkRow.querySelectorAll('td');
  let isNewBlock=true;

  for(let i=0;i<nameCells.length;i++){
    const cell=nameCells[i];
    const link=cell.querySelector('a');
    const primerName=cell.innerText.trim();

    if(primerName&&link){
      if(isNewBlock){
        let rawTooltip=
          link.getAttribute('title')||
          link.getAttribute('data-original-title')||
          link.getAttribute('data-title')||'';

        if(!rawTooltip.trim()){
          rawTooltip=link.innerText.trim();
        }

        const formattedHTML=formatTwoLineOrderInfo(
          rawTooltip
        );
        const targetCheckCell=checkCells[i];

        if(targetCheckCell&&
          !targetCheckCell.querySelector('.cust-info-badge-cf')){
          const badge=document.createElement('div');
          badge.className='cust-info-badge-cf';
          badge.innerHTML=formattedHTML;
          targetCheckCell.appendChild(badge);
        }

        const orderNo=parseOrderAndCustInfo(rawTooltip).orderNo;
        const comments=orderCommentMap.get(orderNo.toUpperCase());
        if(comments&&comments.length){
          upsertReceiptCommentBadge(cell,link,comments);
        }

        isNewBlock=false;
      }
    }else{
      isNewBlock=true;
    }
  }
}

function escapeHtml(s){
  return String(s??'').replace(/[&<>"']/g,ch=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[ch]));
}

function formatTwoLineOrderInfo(str){
  if(!str)return '주문 정보';
  const tokens=str.trim().split(/\s+/);
  const uniqueTokens=[];

  tokens.forEach(token=>{
    if(!uniqueTokens.includes(token))
      uniqueTokens.push(token);
  });

  let orderNo='';
  const custNameParts=[];

  uniqueTokens.forEach(token=>{
    if(/^[A-Z]{1,2}\d{6,10}$|^[A-Z]\d{6}-\d{3}$/i.test(token)){
      if(!orderNo)orderNo=token;
    }else{
      custNameParts.push(token);
    }
  });

  const custName=custNameParts.join(' ');
  if(orderNo&&custName){
    return `
<div style="font-size:10px;margin-bottom:2px">
${escapeHtml(orderNo)}
</div>
<div style="color:#003366">
${escapeHtml(custName)}
</div>`;
  }else if(orderNo){
    return `<div>${escapeHtml(orderNo)}</div>`;
  }else if(custName){
    return `<div>${escapeHtml(custName)}</div>`;
  }
  return `<div>${escapeHtml(str)}</div>`;
}

// ============================================================
// 수량 및 농도 주의 표시
// 칸의 <br> 줄 순서: 0번째 농도, 1번째 사용 횟수 (농도는 빈 줄일 수 있음)
// ============================================================
function isConcentrationAlert(val){
  return val===0||val===1||val>CONC_ALERT_OVER;
}

function highlightAlertNumbers(tables){
  tables.forEach(table=>{
    if(table.classList.contains('box-summary-modal-table'))
      return;

    const rows=getRows(table);
    if(rows.length<6)return;

    [rows[2],rows[5]].forEach(infoRow=>{
      if(!infoRow)return;

      infoRow.querySelectorAll('td').forEach(cell=>{
        if(cell.dataset.limsNumberChecked==='1')return;
        cell.dataset.limsNumberChecked='1';

        const rawHTML=cell.innerHTML;
        const lines=rawHTML.split('<br>').map(l=>l.trim());
        const textLines=cell.innerText.split('\n')
          .map(l=>l.trim()).filter(Boolean);

        if(!textLines.length)return;

        const newLines=lines.map((lineText,idx)=>{
          const plainText=lineText.replace(/<[^>]*>/g,'')
            .trim();

          if(/양없음|스탁반송|스탁 반송/i.test(plainText)){
            return `<span class="num-red-bold-alert">${lineText}</span>`;
          }

          if(idx===0&&/^\d+$/.test(plainText)){
            if(isConcentrationAlert(parseInt(plainText,10))){
              return `<span class="conc-alert-box">${lineText}</span>`;
            }
          }

          const pMatch=plainText.match(/^(\d+)\s*p$/i);
          if(pMatch){
            if(isConcentrationAlert(parseInt(pMatch[1],10))){
              return `<span class="conc-alert-box">${lineText}</span>`;
            }
          }

          if(idx===1&&/^\d+$/.test(plainText)){
            if(parseInt(plainText,10)>=USAGE_ALERT_MIN){
              return `<span class="usage-alert-box">${lineText}</span>`;
            }
          }

          return lineText;
        });

        cell.innerHTML=newLines.join('<br>');
      });
    });
  });
}

// ============================================================
// 동일 시트 및 다른 시트의 프라이머 중복 검사
// ============================================================

// 스크립트가 넣은 배지 글자가 프라이머명으로 읽히지 않도록 링크 글자를 우선 사용
function getPrimerNameFromCell(cell){
  const link=cell.querySelector('a');
  let text=link?(link.innerText||link.textContent||''):'';

  if(!text.trim()){
    const clone=cell.cloneNode(true);
    clone.querySelectorAll(
      '.shared-sheet-badge-day, .receipt-comment-badge'
    ).forEach(b=>b.remove());
    text=clone.textContent||'';
  }

  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  return lines.length?lines[lines.length-1]:'';
}

function highlightValidatedDuplicatePrimers(tables){
  const localDuplicateMap=new Map();
  const storedSharedMap=readSavedMap();

  const pageText=document.body.innerText;
  const currentSheetMatch=pageText.match(
    /\[([A-Za-z0-9-]+)]/
  );
  const sheetTitleMatch=currentSheetMatch?
    currentSheetMatch[1]:'';
  const currentSheetInfo=parseRxnSheetId(
    sheetTitleMatch
  );

  tables.forEach(table=>{
    const rows=getRows(table);
    if(rows.length<6)return;

    [
      [rows[1],rows[2],rows[3]],
      [rows[4],rows[5],rows[6]||rows[rows.length-1]]
    ].forEach(([nameRow,boxRow,checkRow])=>{
      if(!nameRow||!checkRow)return;

      const nameCells=nameRow.querySelectorAll('td');
      const boxCells=boxRow?boxRow.querySelectorAll('td'):[];
      const checkCells=checkRow.querySelectorAll('td');

      let runningOrderNo='';
      let runningCustName='';

      for(let i=0;i<nameCells.length;i++){
        const nameCell=nameCells[i];
        const aTag=nameCell.querySelector('a');
        const primerName=getPrimerNameFromCell(nameCell);
        const boxText=boxCells[i]?
          boxCells[i].innerText.trim():'';
        const status=parsePrimerStatus(boxText);

        let cellOrderNo='';
        let cellCustName='';

        if(aTag){
          const rawTitle=aTag.getAttribute('title')||
            aTag.getAttribute('data-original-title')||'';
          const parsed=parseOrderAndCustInfo(
            rawTitle
          );
          cellOrderNo=parsed.orderNo;
          cellCustName=parsed.custName;
        }

        if(!cellCustName&&checkCells[i]){
          const badges=checkCells[i].querySelectorAll(
            '.cust-info-badge-cf'
          );
          if(badges.length){
            const parsed=parseOrderAndCustInfo(
              badges[0].innerText
            );
            cellOrderNo=parsed.orderNo;
            cellCustName=parsed.custName;
          }
        }

        if(cellOrderNo&&cellCustName){
          runningOrderNo=cellOrderNo;
          runningCustName=cellCustName;
        }

        if(primerName&&
          !/Premix/i.test(primerName)&&
          !/^EZ/i.test(primerName)){

          if(runningCustName&&primerName){
            const localKey=
              `${runningCustName}___${primerName}`.toUpperCase();
            if(!localDuplicateMap.has(localKey)){
              localDuplicateMap.set(localKey,[]);
            }
            localDuplicateMap.get(localKey).push({
              cell:nameCell,
              orderNo:runningOrderNo
            });
          }

          const sharedKey=makeKey(
            runningCustName,primerName
          );

          if(sharedKey&&currentSheetInfo){
            if(!storedSharedMap[sharedKey]){
              storedSharedMap[sharedKey]=[];
            }
            const exists=storedSharedMap[sharedKey].some(
              s=>s.full===currentSheetInfo.full
            );

            if(!exists){
              storedSharedMap[sharedKey].push({
                ...currentSheetInfo,
                status:status
              });
            }

            const sameDayGroup=storedSharedMap[sharedKey]
              .filter(
                s=>s.datePrefix===currentSheetInfo.datePrefix
              );

            if(isEligibleSharedGroup(sameDayGroup)){
              const otherSuffixes=sameDayGroup
                .filter(s=>s.full!==currentSheetInfo.full)
                .map(s=>s.suffix);

              if(otherSuffixes.length>0&&
                !nameCell.querySelector(
                  '.shared-sheet-badge-day'
                )){
                const badge=document.createElement('div');
                badge.className='shared-sheet-badge-day';
                badge.innerText=
                  `[${otherSuffixes.join(', ')}]`;
                nameCell.appendChild(badge);
              }
            }
          }
        }else if(!primerName&&!boxText){
          runningOrderNo='';
          runningCustName='';
        }
      }
    });
  });

  safeStorage.setItem(
    LOCAL_STORAGE_KEY,
    JSON.stringify(storedSharedMap)
  );

  localDuplicateMap.forEach(entries=>{
    if(entries.length>1){
      const distinctOrders=new Set(
        entries.map(e=>e.orderNo).filter(Boolean)
      );
      if(distinctOrders.size>1){
        entries.forEach(e=>{
          e.cell.classList.add('primer-duplicate');
        });
      }
    }
  });
}

function filterDuplicatesOnly(tables){
  resetAllTables();
  tables.forEach(table=>{
    const rows=getRows(table);
    if(rows.length>=6){
      processDuplicateGroup(rows[1],rows[2]);
      processDuplicateGroup(rows[4],rows[5]);
    }
  });
}

function processDuplicateGroup(nameRow,infoRow){
  if(!nameRow||!infoRow)return;
  const nameCells=nameRow.querySelectorAll('td');
  const infoCells=infoRow.querySelectorAll('td');

  for(let i=0;i<nameCells.length;i++){
    const isDup=nameCells[i].classList.contains(
      'primer-duplicate'
    );
    if(!isDup){
      nameCells[i].classList.add('dimmed-primer');
      if(infoCells[i]){
        infoCells[i].classList.add('dimmed-primer');
      }
    }
  }
}

// ============================================================
// 박스 분류 및 원본 필터 함수 유지
// ============================================================
function scanAllAvailableBoxes(tables){
  const boxSet=new Set();

  tables.forEach(table=>{
    const rows=getRows(table);
    [2,5].forEach(rowIndex=>{
      if(!rows[rowIndex])return;

      rows[rowIndex].querySelectorAll('td').forEach(cell=>{
        const lines=cell.innerText.trim().split('\n')
          .map(l=>l.trim()).filter(Boolean);
        lines.forEach(line=>{
          if([
            'Enclosed','Stored','Synthesis','Standard',
            '양없음','스탁반송','스탁 반송'
          ].includes(line))return;

          if(/^[A-Za-z]$/.test(line))return;

          const parsedBox=parseBoxType(line);
          if(parsedBox)boxSet.add(parsedBox);
        });
      });
    });
  });

  return Array.from(boxSet).sort((a,b)=>{
    const pA=getColdRoomPriorityIndex(a);
    const pB=getColdRoomPriorityIndex(b);
    if(pA!==pB)return pA-pB;
    return a.localeCompare(b,undefined,{
      numeric:true,sensitivity:'base'
    });
  });
}

function filterAllTablesByBox(targetBoxList){
  resetAllTables();
  const tables=getArrayTables();

  tables.forEach(table=>{
    const rows=getRows(table);
    if(rows.length>=6){
      processRowGroup(
        rows[1],rows[2],targetBoxList
      );
      processRowGroup(
        rows[4],rows[5],targetBoxList
      );
    }
  });
}

function processRowGroup(nameRow,infoRow,targetBoxList){
  if(!nameRow||!infoRow)return;
  const nameCells=nameRow.querySelectorAll('td');
  const infoCells=infoRow.querySelectorAll('td');

  for(let i=0;i<nameCells.length;i++){
    const nameCell=nameCells[i];
    const infoCell=infoCells[i];
    if(!infoCell)continue;

    const infoText=infoCell.innerText.trim()
      .replace(/제직/g,'제작')
      .replace(/재작/g,'제작')
      .replace(/제쟉/g,'제작');

    const pureBox=extractPureBoxName(
      infoText,getPrimerNameFromCell(nameCell)
    );
    const type=pureBox&&pureBox!=='IS_EXCLUDED_PRIMER'?
      parseBoxType(pureBox):null;

    const isMatched=!!type&&targetBoxList.some(
      targetBox=>type===targetBox
    );

    if(isMatched){
      nameCell.classList.remove(
        'dimmed-primer','primer-blanked'
      );
      nameCell.classList.add('primer-highlight');

      infoCell.classList.remove(
        'dimmed-primer','primer-blanked'
      );
      infoCell.classList.add('primer-highlight');
    }else{
      nameCell.classList.remove(
        'primer-highlight','primer-blanked'
      );
      nameCell.classList.add('dimmed-primer');

      infoCell.classList.remove(
        'primer-highlight','primer-blanked'
      );
      infoCell.classList.add('dimmed-primer');
    }
  }
}

function resetAllTables(){
  const tables=getArrayTables();
  tables.forEach(table=>{
    table.querySelectorAll('td').forEach(cell=>{
      cell.classList.remove(
        'primer-blanked',
        'primer-highlight',
        'dimmed-primer'
      );
    });
  });
}

function setActiveButton(clickedBtn){
  document.querySelectorAll('.primer-filter-btn')
    .forEach(b=>b.classList.remove('active'));
  clickedBtn.classList.add('active');
}

})();
