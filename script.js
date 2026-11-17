// =================================
// 01. EXPERIMENT STATE
// =================================

let started = false;
let finished = false;

let startTime = null;
let events = [];
let eventCount = 0;

let sectionTimers = {};
let visibleSections = new Set();

let scrollTimer = null;
let clockTimer = null;
let typingTimer = null;
let finalResponseStartTime = null;

// =================================
// EPSON PRINTER
// =================================

const PRINTER_IP = "192.168.0.2";

// ePOS-Device 는 8008(http) / 8043(https) 만 받는다.
// https 페이지(GitHub Pages 등)에서는 mixed content 차단 때문에 8043 을 써야 한다.
const PRINTER_PORT = window.location.protocol === "https:" ? 8043 : 8008;

const PRINTER_RETRY_MS = 5000;

let printer = null;
let printerConnecting = false;
let printerRetryTimer = null;
let printerWaiters = [];

const ePosDev = new epson.ePOSDevice();

// 연결이 끊기면 printer 를 비워서 다음 인쇄 때 다시 연결하게 한다.
ePosDev.onreconnecting = () => console.log("Printer reconnecting...");
ePosDev.onreconnect = () => console.log("Printer reconnected");
ePosDev.ondisconnect = () => {
  console.log("Printer disconnected");
  printer = null;
  schedulePrinterRetry();
};

function settlePrinterWaiters(error) {
  const waiters = printerWaiters;
  printerWaiters = [];
  waiters.forEach(cb => cb(error ? null : printer, error));
}

function schedulePrinterRetry() {
  if (printerRetryTimer || finished) return;
  printerRetryTimer = setTimeout(() => {
    printerRetryTimer = null;
    if (!printer) connectPrinter();
  }, PRINTER_RETRY_MS);
}

// callback(printer, error) — 연결되면 printer, 실패하면 error 문자열
function connectPrinter(callback) {

  if (printer) {
    if (callback) callback(printer, null);
    return;
  }

  if (callback) printerWaiters.push(callback);
  if (printerConnecting) return;

  printerConnecting = true;
  clearTimeout(printerRetryTimer);
  printerRetryTimer = null;

  console.log("Printer connecting to " + PRINTER_IP + ":" + PRINTER_PORT);

  ePosDev.connect(PRINTER_IP, PRINTER_PORT, function(data) {

    // https(8043) 연결 성공 시에는 "SSL_CONNECT_OK" 가 온다.
    if (data !== "OK" && data !== "SSL_CONNECT_OK") {
      printerConnecting = false;
      console.log("Printer connection error:", data);
      settlePrinterWaiters("CONNECT_" + data);
      schedulePrinterRetry();
      return;
    }

    ePosDev.createDevice(
      "local_printer",
      ePosDev.DEVICE_TYPE_PRINTER,
      {
        crypto: true,
        buffer: false
      },
      function(devobj, retcode) {
        printerConnecting = false;

        if (retcode === "OK") {
          printer = devobj;
          printer.timeout = 60000;
          console.log("Printer connected");
          settlePrinterWaiters(null);
        } else {
          console.log("Printer device error:", retcode);
          settlePrinterWaiters("DEVICE_" + retcode);
          schedulePrinterRetry();
        }
      }
    );
  });
}

// 페이지를 열 때 미리 연결해 둔다. 실패하면 PRINTER_RETRY_MS 간격으로 재시도.
connectPrinter();

// onDone(success, code) — 인쇄 결과를 알려 준다.
function printJudgments(judgments, result, onDone = () => {}) {

  connectPrinter((connectedPrinter, error) => {
    if (error) {
      onDone(false, error);
      return;
    }
    buildAndSendReceipt(connectedPrinter, judgments, result, onDone);
  });
}

function buildAndSendReceipt(printer, judgments, result, onDone) {

  // 이벤트 유형별 집계
  const countEvents = type =>
    events.filter(event => event.type === type).length;

  const scrollCount = countEvents("scroll");
  const clickCount = countEvents("click");
  const externalCount = countEvents("external_link");
  const sectionEnterCount = countEvents("section_enter");
  const sectionLeaveCount = countEvents("section_leave");
  const hiddenCount = countEvents("page_hidden");

  const formatTime = ms => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return String(minutes).padStart(2, "0") + ":" +
           String(seconds).padStart(2, "0");
  };

  const finalResponse = events.find(
    event => event.type === "final_response"
  );

  // 출력 시작
  printer.addTextLang("ko");

  printer.addTextAlign(printer.ALIGN_CENTER);
  printer.addTextSize(2, 2);
  printer.addText("ENCOUNTER LOG\n");

  printer.addTextSize(1, 1);
  printer.addText("OBSERVATION REPORT\n");
  printer.addText("--------------------------------\n\n");

  // 관찰 데이터
  printer.addTextAlign(printer.ALIGN_LEFT);
  printer.addText("SESSION DATA\n");
  printer.addText("--------------------------------\n");

  printer.addText("실험 시간 : " +
    formatTime(result.total_duration_ms) + "\n");

  printer.addText("총 이벤트 : " +
    result.total_events + "\n");

  printer.addText("스크롤 : " + scrollCount + "회\n");
  printer.addText("클릭 : " + clickCount + "회\n");
  printer.addText("외부 링크 : " + externalCount + "회\n");
  printer.addText("섹션 진입 : " + sectionEnterCount + "회\n");
  printer.addText("섹션 이탈 : " + sectionLeaveCount + "회\n");
  printer.addText("페이지 이탈 : " + hiddenCount + "회\n");

  if (finalResponse) {
    printer.addText("최종 응답 : " +
      finalResponse.response.length + "자\n");
  
    printer.addText("\nRESPONSE\n");
    printer.addText("--------------------------------\n");
  
    printer.addText(finalResponse.response + "\n");
  }

  // 판정문
  printer.addText("\n--------------------------------\n");
  printer.addText("JUDGMENT\n");
  printer.addText("--------------------------------\n\n");

  judgments.forEach((judgment, index) => {
    printer.addText((index + 1) + ". " + judgment + "\n\n");
  });

  printer.addText("\n--------------------------------\n");
  printer.addTextAlign(printer.ALIGN_CENTER);
  printer.addText("END OF RECORD\n\n\n");

  printer.addCut(printer.CUT_FEED);

  // 인쇄 결과 콜백 (용지 없음, 커버 열림, 타임아웃 등)
  printer.onreceive = res => {
    console.log("Print result:", res.success, res.code, "status:", res.status);
    onDone(res.success, res.code);
  };

  printer.onerror = err => {
    console.log("Print error:", err.status, err.responseText);
    onDone(false, "ERROR_" + err.status);
  };

  printer.send();
}

const sections = [
  "section1",
  "section2",
  "section3",
  "section4",
  "section5",
  "section6",
  "section7",
  "lastAnswer"
];


// =================================
// 02. LOG FUNCTION
// =================================

function record(type, data = {}) {

  if (!started || finished) return;

  const event = {
    type: type,
    timestamp: new Date().toISOString(),
    elapsed_ms: Date.now() - startTime,
    ...data
  };

  events.push(event);
  eventCount++;

  const logCount = document.getElementById("log-count");
  if (logCount) {
    logCount.textContent = "EVENTS : " + eventCount;
  }
}


// =================================
// 03. START EXPERIMENT
// =================================

function startExperiment() {

  if (started) return;

  const promptElement = document.getElementById("prompt");
  const prompt = promptElement.value;

  if (!prompt.trim()) return;

  started = true;
  startTime = Date.now();
  lastScrollY = window.scrollY;
  lastScrollTime = Date.now();

  // 질문 전송 후 인트로의 중앙 정렬 해제
  document.getElementById("intro").classList.add("started");

  // 질문 전송을 첫 번째 기록으로 저장
  record("experiment_start", {
    prompt: prompt
  });

  document.getElementById("log-panel").style.display = "block";

  document.getElementById("sendBtn").disabled = true;
  promptElement.disabled = true;

  const firstAnswer = document.getElementById("firstAnswer");
  const answerBox = firstAnswer.querySelector(".ai-message");
  const essay = document.getElementById("essay");

  // HTML에 미리 작성된 답변을 보관한 뒤 비움
  const answerText = answerBox.textContent.trim();

  answerBox.textContent = "";
  answerBox.classList.remove("fade-out", "transitioning");
  firstAnswer.style.display = "block";

  // 답변 영역이 보이도록 화면 이동
  firstAnswer.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

  // 타자 효과 시작
  let i = 0;
  let essayOpened = false;

  typingTimer = setInterval(() => {

    answerBox.textContent += answerText.charAt(i);
    i++;

    // 답변의 35%가 출력되면 에세이를 보여주기 시작
    if (
      !essayOpened &&
      (i >= answerText.length * 0.35 || i >= answerText.length)
    ) {

      essayOpened = true;

      // 답변창 아래쪽 페이드 효과 시작
      answerBox.classList.add("transitioning");

      // 에세이 서서히 등장
      essay.classList.add("visible");

      record("essay_opened");

      // 답변과 에세이의 경계가 화면 아래쪽에 오도록 이동
      setTimeout(() => {

        const answerBottom =
          firstAnswer.getBoundingClientRect().bottom + window.scrollY;

        window.scrollTo({
          top: Math.max(
            0,
            answerBottom - window.innerHeight * 0.62
          ),
          behavior: "smooth"
        });

      }, 150);
    }

    // 답변 출력 완료
    if (i >= answerText.length) {
      clearInterval(typingTimer);
      typingTimer = null;
    }

  }, 15);

  startObservers();
  startClock();
}


// =================================
// 04. SCROLL TRACKING
// =================================

let lastScrollY = window.scrollY;
let lastScrollTime = Date.now();

window.addEventListener("scroll", () => {

  if (!started || finished) return;

  const currentScrollY = window.scrollY;
  const currentTime = Date.now();

  const distance = Math.abs(currentScrollY - lastScrollY);
  const elapsed = currentTime - lastScrollTime;

  const speed = elapsed > 0
    ? distance / elapsed * 1000
    : 0;

  clearTimeout(scrollTimer);

  scrollTimer = setTimeout(() => {

    const maxScroll =
      document.documentElement.scrollHeight - window.innerHeight;

    const percentage = maxScroll > 0
      ? Math.round(currentScrollY / maxScroll * 100)
      : 0;

    record("scroll", {
      scroll_y: currentScrollY,
      scroll_percent: percentage,
      scroll_distance: distance,
      scroll_interval_ms: elapsed,
      scroll_speed: Math.round(speed)
    });

  }, 250);

  lastScrollY = currentScrollY;
  lastScrollTime = currentTime;

}, { passive: true });


// =================================
// 05. SECTION DWELL TIME
// =================================

function startObservers() {

  const observer = new IntersectionObserver(entries => {

    entries.forEach(entry => {

      const id = entry.target.id;

      if (entry.isIntersecting) {

        if (!visibleSections.has(id)) {

          visibleSections.add(id);
          sectionTimers[id] = Date.now();

          record("section_enter", {
            section: id
          });
        }

      } else {

        closeSection(id);
      }

    });

  }, {
    threshold: 0.5
  });

  sections.forEach(id => {

    const el = document.getElementById(id);

    if (el) observer.observe(el);

  });

  window.sectionObserver = observer;
}

function closeSection(id) {

  if (!visibleSections.has(id)) return;

  const duration = Date.now() - sectionTimers[id];

  record("section_leave", {
    section: id,
    visible_duration_ms: duration
  });

  visibleSections.delete(id);
  delete sectionTimers[id];
}


// =================================
// 06. LINK / BUTTON CLICKS
// =================================

document.addEventListener("click", e => {

  if (!started || finished) return;

  const target = e.target.closest("a, button");

  if (!target) return;

  // 종료 버튼 클릭은 제외
  if (target.getAttribute("onclick") === "finishExperiment()") return;

  // 외부 링크인지 확인
  if (target.tagName === "A" && target.href) {

    const url = new URL(target.href);

    if (url.hostname !== window.location.hostname) {
      record("external_link", {
        url: target.href,
        text: target.innerText || target.href
      });
    }
  }

  // 일반 클릭 기록
  record("click", {
    element: target.tagName,
    text: target.innerText || target.href || "",
    id: target.id || null,
    href: target.href || null
  });

});


// =================================
// 08. TAB VISIBILITY
// =================================

document.addEventListener("visibilitychange", () => {

  if (!started || finished) return;

  if (document.hidden) {

    // 화면을 벗어나면 현재 섹션 체류 시간 측정 종료
    [...visibleSections].forEach(id => closeSection(id));

    record("page_hidden");

  } else {

    record("page_visible");

  }

});


// =================================
// 09. CLOCK
// =================================

function startClock() {

  clockTimer = setInterval(() => {

    if (!started || finished) return;

    const seconds = Math.floor((Date.now() - startTime) / 1000);

    const logTime = document.getElementById("log-time");
    if (logTime) {
      logTime.textContent = "TIME : " + seconds + "s";
    }

  }, 1000);

}


// =================================
// 10. FINISH AND EXPORT
// =================================

function finishExperiment() {

  if (!started || finished) return;

  // 진행 중인 타자 효과와 타이머 종료
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }

  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }

  clearTimeout(scrollTimer);

  // 남아 있는 섹션 체류 시간 기록
  [...visibleSections].forEach(id => closeSection(id));

  // 실험 종료 이벤트 기록
  record("experiment_end");

  finished = true;

  const totalTime = Date.now() - startTime;

  // =================================
  // JUDGMENT
  // =================================

  const judgments = [];

  // 1. 빠른 스크롤
  const fastScroll = events.some(event =>
    event.type === "scroll" &&
    event.scroll_speed >= 1500
  );

  if (fastScroll) {
    judgments.push("피관찰자는 관심이 없습니다.");
  }

  // 2. 특정 섹션에 오래 머무름
  const longStay = events.some(event =>
    event.type === "section_leave" &&
    event.visible_duration_ms >= 30000
  );

  if (longStay) {
    judgments.push("피관찰자는 관심이 있습니다.");
  }

  // 3. 외부 링크 클릭
  const externalLink = events.some(event =>
    event.type === "external_link"
  );

  if (externalLink) {
    judgments.push("피관찰자는 확장합니다.");
  } else {
    judgments.push("피관찰자는 유지합니다.");
  }

  // 4. 최종 응답이 짧음
  const finalResponse = events.find(event =>
    event.type === "final_response"
  );

  if (finalResponse && finalResponse.response.length <= 10) {
    judgments.push("피관찰자는 간결합니다.");
  }

  // 5. 최종 응답 작성 시간이 김
  if (
    finalResponse &&
    finalResponse.writing_duration_ms >= 60000
  ) {
    judgments.push("피관찰자는 신중합니다.");
  }

// =================================
// RESULT
// =================================

const result = {
  experiment: "Reading Machine",
  session_start: new Date(startTime).toISOString(),
  session_end: new Date().toISOString(),
  total_duration_ms: totalTime,
  total_events: events.length,
  judgments: judgments,
  events: events
};

  // 최종 로그 데이터 저장
  // exportLog(result);

  // 판정문 영수증 출력
  const logPanel = document.getElementById("log-panel");
  logPanel.innerHTML = "■ RECORDING ENDED<br>PRINTING...";

  printJudgments(judgments, result, (success, code) => {
    logPanel.innerHTML = success
      ? "■ RECORDING ENDED<br>PRINTED"
      : "■ RECORDING ENDED<br>PRINT FAILED : " + code;
  });

}


// =================================
// 11. EXPORT LOG
// =================================

function exportLog(result) {

  const blob = new Blob(
    [JSON.stringify(result, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = "reading_log_" + Date.now() + ".json";
  a.click();

  URL.revokeObjectURL(url);

}

// =================================
// 12. FINAL RESPONSE
// =================================

function submitFinalResponse() {

  if (!started || finished) return;

  const input = document.getElementById("finalPrompt");
  const response = input.value.trim();

  if (!response) {
    input.focus();
    return;
  }

  record("final_response", {
    response: response,
    writing_duration_ms: finalResponseStartTime !== null
      ? Date.now() - finalResponseStartTime
      : 0
  });

  input.disabled = true;
  document.getElementById("finalSendBtn").disabled = true;

  finishExperiment();

}

document.getElementById("finalPrompt").addEventListener("input", () => {

  if (!started || finished) return;

  if (finalResponseStartTime === null) {
    finalResponseStartTime = Date.now();
  }

});
