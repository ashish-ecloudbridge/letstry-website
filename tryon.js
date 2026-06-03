/**
 * LetsTry.online — Web Try-On Portal
 * Handles: Google auth, credit display, garment capture, webcam, Razorpay payments,
 * FASHN try-on API calls, and the compare slider.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.letstry.online/v1";
// For local dev, override:
// const API_BASE = "http://127.0.0.1:8888/v1";

const GOOGLE_CLIENT_ID = "784210277597-8a7sts7dph55kgga8b19lir0gdpb87uf.apps.googleusercontent.com";
const GOOGLE_REDIRECT_URI = window.location.origin + "/tryon.html";
const GOOGLE_SCOPE = "openid email profile";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let accessToken = null;
let userProfile = null;
let selfieDataUrl = null;
let garmentDataUrl = null;
let selectedPackId = "pack_25";
let cameraStream = null;
let isDragging = false;
let latestResultUrl = null;

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
function setStatus(msg, type = "") {
  const el = $("status-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = "status-msg" + (type ? " " + type : "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth & Google Identity Services (GIS)
// ─────────────────────────────────────────────────────────────────────────────

let tokenClient = null;

function initTokenClient() {
  if (typeof google === "undefined" || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initTokenClient, 100);
    return;
  }
  
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPE,
    callback: async (tokenResponse) => {
      if (tokenResponse && tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        localStorage.setItem("lt_token", accessToken);
        // Clear cached profile to fetch fresh
        localStorage.removeItem("lt_profile");
        
        const btn = $("sign-in-btn");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Continue with Google";
        }
        
        await loadPortalApp();
      } else {
        const btn = $("sign-in-btn");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Continue with Google";
        }
        if (tokenResponse && tokenResponse.error) {
          setStatus("Sign-in failed: " + tokenResponse.error, "error");
        } else {
          setStatus("Sign-in cancelled.", "error");
        }
      }
    },
  });
}

function startSignIn() {
  const btn = $("sign-in-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Opening Google Sign-In…"; }

  if (tokenClient) {
    tokenClient.requestAccessToken();
  } else {
    initTokenClient();
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (tokenClient) {
        clearInterval(interval);
        tokenClient.requestAccessToken();
      } else if (attempts > 15) {
        clearInterval(interval);
        if (btn) { btn.disabled = false; btn.textContent = "Continue with Google"; }
        setStatus("Google Sign-In script did not load. Please check your connection.", "error");
      }
    }, 100);
  }
}

function extractTokenFromHash() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  return params.get("access_token") || null;
}

async function fetchUserProfile(token) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Could not fetch user profile.");
  return res.json();
}

function renderHeader(profile, credits) {
  const hr = $("header-right");
  const creditsLow = credits <= 1;
  hr.innerHTML = `
    <div class="credit-pill${creditsLow ? " low" : ""}" id="credit-pill">
      ${creditsLow ? "⚠" : "✦"} ${credits} credit${credits !== 1 ? "s" : ""}
    </div>
    <button class="btn-buy" onclick="openModal()">Buy Credits</button>
    <div class="user-avatar-chip">
      <div class="user-avatar-img">
        ${profile.picture ? `<img src="${profile.picture}" alt="" />` : profile.name?.[0] || "U"}
      </div>
      <span>${profile.given_name || profile.name || "User"}</span>
    </div>
    <button class="btn-signout" onclick="signOut()">Sign out</button>
    <a href="/" style="font-size:13px;font-weight:600;color:#64748b;text-decoration:none;">← Back</a>
  `;
}

function updateCreditDisplay(credits) {
  const pill = $("credit-pill");
  if (!pill) return;
  const creditsLow = credits <= 1;
  pill.className = "credit-pill" + (creditsLow ? " low" : "");
  pill.textContent = `${creditsLow ? "⚠" : "✦"} ${credits} credit${credits !== 1 ? "s" : ""}`;
  const note = $("generate-credit-note");
  if (note) note.textContent = `${credits} credit${credits !== 1 ? "s" : ""} remaining — 1 credit per try-on`;
}

function signOut() {
  accessToken = null;
  localStorage.removeItem("lt_token");
  localStorage.removeItem("lt_profile");
  localStorage.removeItem("lt_credits");
  window.location.href = "/tryon.html";
}

async function initAuth() {
  // 1. Check URL hash for token (fallback or redirect flow)
  const hashToken = extractTokenFromHash();
  if (hashToken) {
    accessToken = hashToken;
    localStorage.setItem("lt_token", hashToken);
    // Clean hash from URL
    history.replaceState(null, "", window.location.pathname);
  } else {
    // 2. Check local storage
    accessToken = localStorage.getItem("lt_token") || null;
  }

  if (!accessToken) {
    // Show auth gate
    $("auth-gate").style.display = "block";
    initTokenClient();
    return;
  }

  await loadPortalApp();
}

async function loadPortalApp() {
  try {
    // Fetch profile
    const cached = localStorage.getItem("lt_profile");
    if (cached) {
      userProfile = JSON.parse(cached);
    } else {
      userProfile = await fetchUserProfile(accessToken);
      localStorage.setItem("lt_profile", JSON.stringify(userProfile));
    }

    // Show portal
    $("auth-gate").style.display = "none";
    $("portal-app").classList.add("visible");

    // Fetch credits
    const creditsData = await fetchCredits();
    renderHeader(userProfile, creditsData.credits_remaining);
    updateCreditDisplay(creditsData.credits_remaining);

    // Cache credits
    localStorage.setItem("lt_credits", creditsData.credits_remaining);

    // Claim pending referral if any
    await claimPendingReferral();

    // Check for buy hash
    if (window.location.hash === "#buy") openModal();

    // Init compare slider
    initCompareSlider();
    updateGenerateBtn();
  } catch (err) {
    console.error("Portal loading failed:", err);
    // Token expired or invalid
    accessToken = null;
    localStorage.removeItem("lt_token");
    localStorage.removeItem("lt_profile");
    localStorage.removeItem("lt_credits");
    $("auth-gate").style.display = "block";
    initTokenClient();
  }
}

function handleReferralLink() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref");
  if (ref) {
    localStorage.setItem("lt_ref", ref);
    // Log click on the backend
    fetch(`${API_BASE}/referrals/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referrer_id: ref })
    }).catch(err => console.error("Could not log referral click:", err));
  }
}

async function claimPendingReferral() {
  const ref = localStorage.getItem("lt_ref");
  if (!ref || !accessToken) return;
  
  // Prevent self-referral
  if (userProfile && (userProfile.sub === ref || userProfile.id === ref)) {
    localStorage.removeItem("lt_ref");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/referrals/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ referrer_id: ref })
    });
    if (res.ok) {
      const data = await res.json();
      localStorage.removeItem("lt_ref");
      if (data.credits_remaining !== undefined) {
        updateCreditDisplay(data.credits_remaining);
        renderHeader(userProfile, data.credits_remaining);
        localStorage.setItem("lt_credits", data.credits_remaining);
      }
      setStatus("🎉 Referral claimed! +5 credits granted.", "success");
    }
  } catch (err) {
    console.error("Could not claim referral:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credits API
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCredits() {
  const res = await fetch(`${API_BASE}/credits`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Could not fetch credits.");
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Camera / Selfie
// ─────────────────────────────────────────────────────────────────────────────

function selfieShellClick() {
  if (!cameraStream && !selfieDataUrl) {
    document.getElementById("file-upload").click();
  }
}

async function startCamera() {
  try {
    if (cameraStream) {
      stopCamera();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 768 }, height: { ideal: 1024 } },
    });
    cameraStream = stream;
    const video = $("webcam-video");
    video.srcObject = stream;
    video.style.display = "block";
    $("selfie-placeholder").style.display = "none";
    $("selfie-img").style.display = "none";
    $("camera-btn").textContent = "⏹ Stop";
    $("capture-btn").style.display = "flex";
  } catch (err) {
    setStatus("Camera not available: " + err.message, "error");
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  $("webcam-video").style.display = "none";
  $("camera-btn").textContent = "📷 Camera";
  $("capture-btn").style.display = "none";
}

function captureSnapshot() {
  const video = $("webcam-video");
  const canvas = $("capture-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  selfieDataUrl = canvas.toDataURL("image/jpeg", 0.9);

  // Mirror correction (front camera mirrors)
  const mirrorCanvas = document.createElement("canvas");
  mirrorCanvas.width = canvas.width;
  mirrorCanvas.height = canvas.height;
  const mCtx = mirrorCanvas.getContext("2d");
  mCtx.translate(canvas.width, 0);
  mCtx.scale(-1, 1);
  mCtx.drawImage(canvas, 0, 0);
  selfieDataUrl = mirrorCanvas.toDataURL("image/jpeg", 0.9);

  const img = $("selfie-img");
  img.src = selfieDataUrl;
  img.style.display = "block";
  stopCamera();
  $("selfie-placeholder").style.display = "none";

  // Update before-image in compare slider
  const before = $("compare-before");
  if (before) { before.src = selfieDataUrl; before.style.display = "block"; }

  updateGenerateBtn();
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    selfieDataUrl = e.target.result;
    $("selfie-img").src = selfieDataUrl;
    $("selfie-img").style.display = "block";
    $("selfie-placeholder").style.display = "none";
    $("webcam-video").style.display = "none";
    const before = $("compare-before");
    if (before) { before.src = selfieDataUrl; before.style.display = "block"; }
    updateGenerateBtn();
  };
  reader.readAsDataURL(file);
  event.target.value = "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Garment
// ─────────────────────────────────────────────────────────────────────────────

function onGarmentUrlInput() {
  $("garment-status").textContent = "Press Load to open the product page.";
}

async function loadGarmentUrl() {
  const url = $("garment-url").value.trim();
  if (!url) { $("garment-status").textContent = "Please paste a product URL first."; return; }

  $("garment-status").textContent = "Trying to auto-fetch product image…";
  $("garment-preview-shell").style.display = "block";

  // Step 1: Try to auto-scrape the garment image from the backend / direct URL
  const scraped = await tryAutoScrapeGarment(url);
  if (scraped) {
    garmentDataUrl = scraped;
    showGarmentCaptured(scraped);
    $("garment-status").textContent = "✅ Garment captured automatically!";
    updateGenerateBtn();
    return;
  }

  // Step 2: Fallback — open in iframe + let user click Capture
  $("garment-status").textContent = "Auto-scrape blocked. Open the page below and click 'Capture Garment'.";
  $("iframe-zone").style.display = "block";
  $("garment-iframe").src = url;
  $("garment-captured").style.display = "none";
}

async function tryAutoScrapeGarment(productUrl) {
  try {
    // Attempt to load image directly (works if CDN allows it)
    const imgUrl = await extractImageFromUrl(productUrl);
    if (!imgUrl) return null;

    // Convert to data URL via fetch + canvas
    const res = await fetch(imgUrl, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

async function extractImageFromUrl(pageUrl) {
  // Try fetching via a CORS proxy or direct; extract first product image
  // This is a best-effort approach — works for open CDNs
  try {
    const res = await fetch(pageUrl, { mode: "cors", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const html = await res.text();
    const matches = html.match(/https:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)[^"'\s]*/gi);
    if (!matches) return null;
    // Heuristic: find first large product image URL
    const productImg = matches.find(u =>
      (u.includes("product") || u.includes("item") || u.includes("catalog") || u.includes("image")) &&
      !u.includes("logo") && !u.includes("icon") && !u.includes("banner")
    ) || matches[0];
    return productImg;
  } catch {
    return null;
  }
}

function captureIframe() {
  // html2canvas is heavy — use screenshot API or just prompt user to upload
  // We'll fall back to asking user to upload garment image directly
  $("garment-status").textContent = "Please use 'Upload garment image' below to add the garment photo.";
  $("iframe-zone").style.display = "none";
}

function handleGarmentUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    garmentDataUrl = e.target.result;
    showGarmentCaptured(garmentDataUrl);
    $("garment-status").textContent = "✅ Garment image loaded!";
    updateGenerateBtn();
  };
  reader.readAsDataURL(file);
  event.target.value = "";
}

function showGarmentCaptured(dataUrl) {
  $("garment-preview-shell").style.display = "block";
  $("iframe-zone").style.display = "none";
  const img = $("garment-captured");
  img.src = dataUrl;
  img.classList.add("visible");
  img.style.display = "block";
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate Try-On
// ─────────────────────────────────────────────────────────────────────────────

function updateGenerateBtn() {
  const btn = $("generate-btn");
  if (!btn) return;
  btn.disabled = !(selfieDataUrl && garmentDataUrl);
}

async function generateTryOn() {
  if (!selfieDataUrl || !garmentDataUrl) {
    setStatus("Please add a selfie and a garment first.", "error"); return;
  }
  if (!accessToken) {
    setStatus("Please sign in first.", "error"); return;
  }

  const btn = $("generate-btn");
  btn.disabled = true;
  setStatus("");

  // Show scanning beam
  const beam = $("scanning-beam");
  if (beam) beam.classList.add("visible");
  $("result-empty").style.display = "none";

  // Progress
  showProgress("Uploading images…", 15);

  try {
    const body = {
      user_image: selfieDataUrl,
      garment_image: garmentDataUrl,
    };

    showProgress("Running AI try-on (FASHN v1.5)…", 40);

    const res = await fetch(`${API_BASE}/tryon`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    // 402 — out of credits
    if (res.status === 402) {
      hideProgress();
      if (beam) beam.classList.remove("visible");
      setStatus("❌ Out of credits. Purchase more to continue.", "error");
      openModal();
      btn.disabled = false;
      return;
    }

    if (!res.ok) {
      throw new Error(data.detail || data.message || `HTTP ${res.status}`);
    }

    showProgress("Rendering result…", 90);
    const resultUrl = data.tryon_result_url;
    if (!resultUrl) throw new Error("No result URL returned from API.");

    latestResultUrl = resultUrl;

    // Show result in compare slider
    const afterImg = $("compare-after");
    afterImg.src = resultUrl;
    afterImg.onload = () => {
      hideProgress();
      if (beam) beam.classList.remove("visible");

      $("compare-handle").classList.add("visible");
      // Animate from fully closed to 50%
      animateSlider(100, 50, 900);

      showProgress("", 100);
      hideProgress();

      // Download link
      $("download-link").href = resultUrl;
      $("result-actions").classList.add("visible");

      setStatus(data.message || "Try-on complete! Drag the slider to compare.", "success");
    };

    // Update credits display
    if (data.message) {
      const match = data.message.match(/(\d+) credit/);
      if (match) {
        const rem = parseInt(match[1], 10);
        updateCreditDisplay(rem);
      }
    }

  } catch (err) {
    hideProgress();
    if (beam) beam.classList.remove("visible");
    $("result-empty").style.display = "flex";
    setStatus("❌ " + (err.message || "Try-on failed. Please try again."), "error");
  } finally {
    btn.disabled = false;
    updateGenerateBtn();
  }
}

function showProgress(label, pct) {
  $("progress-area").classList.add("visible");
  $("progress-label").textContent = label;
  $("progress-bar").style.width = pct + "%";
}

function hideProgress() {
  $("progress-area").classList.remove("visible");
  $("progress-bar").style.width = "0";
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare Slider
// ─────────────────────────────────────────────────────────────────────────────

function initCompareSlider() {
  const container = $("compare-container");
  const clip = $("compare-after-clip");
  const handle = $("compare-handle");
  if (!container) return;

  function updateSlider(clientX) {
    const rect = container.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    clip.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = pct + "%";
  }

  container.addEventListener("mousedown", e => { isDragging = true; updateSlider(e.clientX); });
  window.addEventListener("mouseup", () => { isDragging = false; });
  window.addEventListener("mousemove", e => { if (isDragging) updateSlider(e.clientX); });
  container.addEventListener("touchstart", e => { isDragging = true; updateSlider(e.touches[0].clientX); });
  window.addEventListener("touchend", () => { isDragging = false; });
  window.addEventListener("touchmove", e => { if (isDragging) updateSlider(e.touches[0].clientX); });
}

function animateSlider(from, to, duration) {
  const clip = $("compare-after-clip");
  const handle = $("compare-handle");
  const start = performance.now();
  function frame(now) {
    if (isDragging) return;
    const elapsed = now - start;
    const ratio = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - ratio, 3);
    const pct = from + (to - from) * eased;
    if (clip) clip.style.clipPath = `inset(0 0 0 ${pct}%)`;
    if (handle) handle.style.left = pct + "%";
    if (ratio < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay Credits Purchase
// ─────────────────────────────────────────────────────────────────────────────

function openModal() {
  $("credits-modal").classList.add("open");
  $("modal-status").textContent = "";
}

function closeModal() {
  $("credits-modal").classList.remove("open");
  if (window.location.hash === "#buy") history.replaceState(null, "", window.location.pathname);
}

function selectPack(packId, el) {
  selectedPackId = packId;
  document.querySelectorAll(".pack-card").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
}

async function startPayment() {
  if (!accessToken) { $("modal-status").textContent = "Please sign in first."; return; }
  const payBtn = $("pay-btn");
  payBtn.disabled = true;
  payBtn.textContent = "Creating order…";
  $("modal-status").textContent = "";

  try {
    const res = await fetch(`${API_BASE}/credits/purchase`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pack_id: selectedPackId }),
    });

    const order = await res.json();
    if (!res.ok) throw new Error(order.detail || "Failed to create order.");

    const options = {
      key: order.key,
      amount: order.amount,
      currency: order.currency,
      name: "LetsTry.online",
      description: order.pack_label,
      image: window.location.origin + "/logo.png",
      order_id: order.order_id,
      handler: async function (response) {
        await verifyPayment(response, order.order_id);
      },
      prefill: {
        name: userProfile?.name || "",
        email: userProfile?.email || "",
      },
      theme: { color: "#1d4ed8" },
      modal: {
        ondismiss: () => {
          payBtn.disabled = false;
          payBtn.textContent = "Pay with Razorpay";
        },
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.on("payment.failed", function (response) {
      $("modal-status").textContent = "Payment failed: " + (response.error?.description || "Unknown error");
      payBtn.disabled = false;
      payBtn.textContent = "Pay with Razorpay";
    });
    rzp.open();

  } catch (err) {
    $("modal-status").textContent = "❌ " + err.message;
    payBtn.disabled = false;
    payBtn.textContent = "Pay with Razorpay";
  }
}

async function verifyPayment(rzpResponse, orderId) {
  const payBtn = $("pay-btn");
  payBtn.textContent = "Verifying…";
  $("modal-status").textContent = "";

  try {
    const res = await fetch(`${API_BASE}/credits/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        order_id: orderId,
        payment_id: rzpResponse.razorpay_payment_id,
        signature: rzpResponse.razorpay_signature,
        pack_id: selectedPackId,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Verification failed.");

    $("modal-status").textContent = `✅ ${data.credits_added} credits added!`;
    updateCreditDisplay(data.credits_remaining);
    setTimeout(() => closeModal(), 1800);
  } catch (err) {
    $("modal-status").textContent = "❌ " + err.message + " — contact support if charged.";
  } finally {
    payBtn.disabled = false;
    payBtn.textContent = "Pay with Razorpay";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  handleReferralLink();
  initAuth();
  initTokenClient();
});
