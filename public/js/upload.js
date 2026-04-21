import { state } from "./state.js";
import { dom } from "./dom.js";
import { esc } from "./helpers.js";
import { toggleIntelPanel, switchIntelTab } from "./intel-panel.js";
import { loadNotesTree } from "./notes/browser.js";
import { checkNotesStatus } from "./notes/git-sync.js";

// File upload overlay — drag-and-drop or click to select files. Uploads land in
// _clippings/ and optionally trigger /ingest in the Claude Code pty.

const uploadOverlay = document.getElementById("upload-overlay");
const uploadDropzone = document.getElementById("upload-dropzone");
const uploadFileInput = document.getElementById("upload-file-input");
const uploadFileList = document.getElementById("upload-file-list");
const uploadActions = document.getElementById("upload-actions");
const uploadSubmitBtn = document.getElementById("upload-submit-btn");
const uploadProgress = document.getElementById("upload-progress");
const uploadProgressFill = document.getElementById("upload-progress-fill");
const uploadProgressText = document.getElementById("upload-progress-text");
const uploadAutoIngest = document.getElementById("upload-auto-ingest");

export function openUploadOverlay() {
  uploadOverlay.classList.add("visible");
  state.pendingUploadFiles = [];
  uploadFileList.innerHTML = "";
  uploadProgress.style.display = "none";
  uploadActions.style.display = "none";
}

function closeUploadOverlay() {
  uploadOverlay.classList.remove("visible");
  state.pendingUploadFiles = [];
  uploadFileInput.value = "";
}

function addUploadFiles(fileList) {
  for (const f of fileList) {
    if (f.size > 50 * 1024 * 1024) continue;
    if (!state.pendingUploadFiles.find(p => p.name === f.name && p.size === f.size)) {
      state.pendingUploadFiles.push(f);
    }
  }
  renderUploadFiles();
  uploadActions.style.display = state.pendingUploadFiles.length > 0 ? "flex" : "none";
}

function renderUploadFiles() {
  uploadFileList.innerHTML = state.pendingUploadFiles.map((f, i) => {
    const sz = f.size < 1024 ? f.size + " B"
      : f.size < 1048576 ? (f.size / 1024).toFixed(1) + " KB"
      : (f.size / 1048576).toFixed(1) + " MB";
    return `<div class="upload-file-item"><span class="upload-file-name">${esc(f.name)}</span><span class="upload-file-size">${sz}</span><button class="upload-file-remove" data-idx="${i}">&times;</button></div>`;
  }).join("");
}

export function initUpload() {
  uploadFileList.addEventListener("click", e => {
    const btn = e.target.closest(".upload-file-remove");
    if (btn) {
      state.pendingUploadFiles.splice(parseInt(btn.dataset.idx), 1);
      renderUploadFiles();
      uploadActions.style.display = state.pendingUploadFiles.length ? "flex" : "none";
    }
  });
  document.getElementById("sidebar-upload-btn").addEventListener("click", openUploadOverlay);
  document.getElementById("upload-close-btn").addEventListener("click", closeUploadOverlay);
  uploadOverlay.addEventListener("click", e => { if (e.target === uploadOverlay) closeUploadOverlay(); });
  uploadDropzone.addEventListener("click", () => uploadFileInput.click());
  uploadFileInput.addEventListener("change", () => {
    if (uploadFileInput.files.length) addUploadFiles(uploadFileInput.files);
    uploadFileInput.value = "";
  });
  uploadDropzone.addEventListener("dragover", e => { e.preventDefault(); uploadDropzone.classList.add("dragover"); });
  uploadDropzone.addEventListener("dragleave", () => uploadDropzone.classList.remove("dragover"));
  uploadDropzone.addEventListener("drop", e => {
    e.preventDefault();
    uploadDropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length) addUploadFiles(e.dataTransfer.files);
  });

  uploadSubmitBtn.addEventListener("click", async () => {
    if (!state.pendingUploadFiles.length) return;
    const formData = new FormData();
    for (const f of state.pendingUploadFiles) formData.append("files", f);
    const autoIngest = uploadAutoIngest.checked;
    uploadSubmitBtn.disabled = true;
    uploadActions.style.display = "none";
    uploadProgress.style.display = "flex";
    uploadProgressText.textContent = "Uploading...";
    uploadProgressFill.style.width = "0%";
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/notes/upload?ingest=${autoIngest}`);
        xhr.upload.addEventListener("progress", e => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            uploadProgressFill.style.width = pct + "%";
            uploadProgressText.textContent = `Uploading... ${pct}%`;
          }
        });
        xhr.onload = () => {
          if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
          else reject(new Error(xhr.responseText));
        };
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.send(formData);
      });
      uploadProgressFill.style.width = "100%";
      if (result.ingestTriggered) {
        uploadProgressText.textContent = "Uploaded! Ingest started — check terminal.";
        if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel();
        switchIntelTab("terminal");
      } else {
        uploadProgressText.textContent = "Uploaded to _clippings/";
      }
      setTimeout(() => loadNotesTree(), 1000);
      setTimeout(() => { closeUploadOverlay(); uploadSubmitBtn.disabled = false; }, 2500);
      // If ingest was triggered, re-poll tree + status a couple times to catch the
      // new notes once Claude Code finishes the ingest.
      if (result.ingestTriggered) {
        setTimeout(() => { loadNotesTree(); checkNotesStatus(); }, 30000);
        setTimeout(() => { loadNotesTree(); checkNotesStatus(); }, 60000);
      }
    } catch (err) {
      uploadProgressText.textContent = "Failed: " + (err.message || "Unknown error");
      uploadSubmitBtn.disabled = false;
      uploadActions.style.display = "flex";
    }
  });
}
