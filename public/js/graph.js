import { state } from "./state.js";
import { dom } from "./dom.js";
import { esc } from "./helpers.js";
import { getTheme } from "./theme.js";
import { openNote } from "./notes/browser.js";
import { closeCmdBar } from "./cmd-bar.js";

// Knowledge graph — force-directed visualization of all notes + wiki-link edges.
// Uses a Neo4j/D3-style physics sim with constant repulsion, Hooke's law attraction
// along edges, and alpha to cool down movement speed over time. Dragging a node
// pins it where you drop it.

export const TOPIC_COLORS = ["#818cf8", "#4ade80", "#60a5fa", "#fbbf24", "#f87171", "#a78bfa", "#34d399", "#fb923c", "#e879f9", "#22d3ee"];
function topicColor(dir, dirs) {
  return TOPIC_COLORS[dirs.indexOf(dir) % TOPIC_COLORS.length];
}

export async function openGraph() {
  dom.graphOverlay.classList.add("visible");
  state.graphSearchQuery = "";
  // Command bar opens in graph-search mode
  dom.cmdBar.classList.add("visible");
  dom.cmdInput.placeholder = "Search graph nodes...";
  const W = dom.graphOverlay.clientWidth, H = dom.graphOverlay.clientHeight - 52;
  dom.graphCanvas.width = W; dom.graphCanvas.height = H;
  const ctx = dom.graphCanvas.getContext("2d");
  ctx.fillStyle = getTheme() === "dark" ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)";
  ctx.font = "13px system-ui"; ctx.textAlign = "center";
  ctx.fillText("Loading graph...", W / 2, H / 2);
  try {
    const res = await fetch("/api/notes/graph");
    state.graphData = await res.json();
    if (!state.graphData.nodes.length) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getTheme() === "dark" ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)";
      ctx.fillText("No notes found", W / 2, H / 2);
      return;
    }
    initGraph();
  } catch {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getTheme() === "dark" ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)";
    ctx.fillText("Failed to load graph", W / 2, H / 2);
  }
}

function initGraph() {
  const { nodes, edges } = state.graphData;
  const W = dom.graphCanvas.clientWidth, H = dom.graphCanvas.clientHeight;
  const dirs = [...new Set(nodes.map(n => n.dir))];
  const dpr = window.devicePixelRatio || 1;
  dom.graphCanvas.width = W * dpr; dom.graphCanvas.height = H * dpr;
  dom.graphCanvas.style.width = W + "px"; dom.graphCanvas.style.height = H + "px";

  let zoom = 1, panX = 0, panY = 0;
  let dragNode = null, hoveredNode = null;
  let alpha = 1; // Simulation energy — controls velocity integration speed

  state.graphNodes = nodes.map(n => ({
    ...n,
    x: W / 2 + (Math.random() - 0.5) * W * 0.8,
    y: H / 2 + (Math.random() - 0.5) * H * 0.8,
    vx: 0, vy: 0, conns: 0,
    color: topicColor(n.dir, dirs),
    pinned: false,
  }));
  for (const e of edges) {
    state.graphNodes[e.source].conns++;
    state.graphNodes[e.target].conns++;
  }

  // Physics step — Neo4j/D3-style: forces are constant, alpha only scales movement.
  function physicsTick() {
    // Repulsion (Coulomb-ish) between all node pairs
    for (let i = 0; i < state.graphNodes.length; i++) {
      if (state.graphNodes[i].pinned) continue;
      for (let j = 0; j < state.graphNodes.length; j++) {
        if (i === j) continue;
        const dx = state.graphNodes[j].x - state.graphNodes[i].x;
        const dy = state.graphNodes[j].y - state.graphNodes[i].y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.max(1, Math.sqrt(distSq));
        const f = -4000 / (distSq + 100); // softened at close range
        state.graphNodes[i].vx += (dx / dist) * f;
        state.graphNodes[i].vy += (dy / dist) * f;
      }
    }
    // Attraction (Hooke's law) along edges
    const idealLen = 100;
    for (const e of edges) {
      const a = state.graphNodes[e.source], b = state.graphNodes[e.target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (dist - idealLen) * 0.008;
      if (!a.pinned) { a.vx += (dx / dist) * f; a.vy += (dy / dist) * f; }
      if (!b.pinned) { b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f; }
    }
    // Centering + pull for isolated nodes so they don't drift off
    let cx = 0, cy = 0, freeCount = 0;
    for (const n of state.graphNodes) {
      if (!n.pinned) { cx += n.x; cy += n.y; freeCount++; }
    }
    if (freeCount > 0) {
      cx /= freeCount; cy /= freeCount;
      for (const n of state.graphNodes) {
        if (n.pinned) continue;
        n.vx += (W / 2 - cx) * 0.0005;
        n.vy += (H / 2 - cy) * 0.0005;
        if (n.conns <= 1) {
          n.vx += (W / 2 - n.x) * 0.002;
          n.vy += (H / 2 - n.y) * 0.002;
        }
      }
    }
    // Integrate + damp
    for (const n of state.graphNodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= 0.88; n.vy *= 0.88;
    }
    alpha = Math.max(0.04, alpha * 0.997); // cool down but never fully stop
  }

  function reheat(amount = 0.3) { alpha = Math.max(alpha, amount); }

  function getConnected(nodeIdx) {
    const set = new Set([nodeIdx]);
    for (const e of edges) {
      if (e.source === nodeIdx) set.add(e.target);
      if (e.target === nodeIdx) set.add(e.source);
    }
    return set;
  }

  function fromCanvas(cx, cy) { return [cx / zoom - panX, cy / zoom - panY]; }

  function draw() {
    const isDark = getTheme() === "dark";
    const edgeColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
    const edgeDimColor = isDark ? "rgba(255,255,255,0.015)" : "rgba(0,0,0,0.02)";
    const labelColor = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)";
    const hoverColor = isDark ? "#fff" : "#111";

    const ctx = dom.graphCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(panX * zoom, panY * zoom);
    ctx.scale(zoom, zoom);

    const focusSet = hoveredNode ? getConnected(state.graphNodes.indexOf(hoveredNode)) : null;
    const searchLower = state.graphSearchQuery.toLowerCase();
    const searchMatches = searchLower
      ? new Set(state.graphNodes.map((n, i) => n.name.toLowerCase().includes(searchLower) || n.path.toLowerCase().includes(searchLower) ? i : -1).filter(i => i >= 0))
      : null;

    // Edges
    for (const e of edges) {
      const a = state.graphNodes[e.source], b = state.graphNodes[e.target];
      const dim = focusSet && !focusSet.has(e.source) && !focusSet.has(e.target);
      const searchDim = searchMatches && !searchMatches.has(e.source) && !searchMatches.has(e.target);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = dim || searchDim ? edgeDimColor : edgeColor;
      ctx.lineWidth = 0.8; ctx.stroke();
    }

    // Nodes
    state.graphNodes.forEach((n, i) => {
      const r = 3 + Math.min(n.conns, 15) * 0.7;
      const isHovered = n === hoveredNode;
      const isFocused = focusSet ? focusSet.has(i) : true;
      const isSearchMatch = searchMatches ? searchMatches.has(i) : true;
      const dim = !isFocused || !isSearchMatch;

      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? hoverColor : n.color;
      ctx.globalAlpha = dim ? 0.1 : (isHovered ? 1 : 0.75);
      ctx.fill();

      if (isHovered) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = n.color; ctx.globalAlpha = 0.15; ctx.fill();
      }

      if (isHovered || (isSearchMatch && searchMatches) || (!dim && n.conns >= 5 && zoom >= 0.8)) {
        ctx.globalAlpha = dim ? 0.15 : 0.85;
        ctx.fillStyle = isHovered ? hoverColor : labelColor;
        ctx.font = `${isHovered ? 12 : 10}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(n.name.slice(0, 24), n.x, n.y - r - 5);
      }
      ctx.globalAlpha = 1;
    });

    ctx.restore();
    dom.graphStats.textContent = `${nodes.length} notes \u00B7 ${edges.length} connections \u00B7 ${Math.round(zoom * 100)}%`;
  }

  function tick() {
    physicsTick();
    draw();
    state.graphAnimFrame = requestAnimationFrame(tick);
  }
  state.graphAnimFrame = requestAnimationFrame(tick);

  // --- Mouse interaction ---
  let isDraggingCanvas = false, lastMouse = null;
  let dragStartPos = null, didDrag = false;

  function getMouseNode(mx, my) {
    const [wx, wy] = fromCanvas(mx, my);
    for (let i = state.graphNodes.length - 1; i >= 0; i--) {
      const n = state.graphNodes[i];
      // Hit-test only on the circle (with small padding), not the label
      const r = (3 + Math.min(n.conns, 15) * 0.7) / zoom + 6;
      const dx = n.x - wx, dy = n.y - wy;
      if (dx * dx + dy * dy < r * r) return n;
    }
    return null;
  }

  dom.graphCanvas.onmousedown = e => {
    e.preventDefault();
    const rect = dom.graphCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    dragStartPos = { x: e.clientX, y: e.clientY };
    didDrag = false;
    const node = getMouseNode(mx, my);
    if (node) {
      dragNode = node; node.pinned = true;
      dom.graphCanvas.style.cursor = "grabbing";
    } else {
      isDraggingCanvas = true;
      lastMouse = { x: e.clientX, y: e.clientY };
      dom.graphCanvas.style.cursor = "grabbing";
    }
  };

  dom.graphCanvas.onmousemove = e => {
    const rect = dom.graphCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // Distinguish drag from click: >5px movement counts as drag
    if (dragStartPos) {
      const movedDist = Math.abs(e.clientX - dragStartPos.x) + Math.abs(e.clientY - dragStartPos.y);
      if (movedDist > 5) didDrag = true;
    }

    if (dragNode) {
      const [wx, wy] = fromCanvas(mx, my);
      dragNode.x = wx; dragNode.y = wy;
      reheat(0.15);
      return;
    }

    if (isDraggingCanvas && lastMouse) {
      panX += (e.clientX - lastMouse.x) / zoom;
      panY += (e.clientY - lastMouse.y) / zoom;
      lastMouse = { x: e.clientX, y: e.clientY };
      return;
    }

    hoveredNode = getMouseNode(mx, my);
    dom.graphCanvas.style.cursor = hoveredNode ? "pointer" : "grab";
    if (hoveredNode) {
      dom.graphTooltip.textContent = hoveredNode.path;
      dom.graphTooltip.style.left = (e.clientX + 12) + "px";
      dom.graphTooltip.style.top = (e.clientY - 8) + "px";
      dom.graphTooltip.classList.add("visible");
    } else {
      dom.graphTooltip.classList.remove("visible");
    }
  };

  dom.graphCanvas.onmouseup = () => {
    const clickedNode = hoveredNode;

    if (dragNode) {
      // Node stays pinned where you dropped it (Neo4j behavior)
      dragNode.pinned = true;
      reheat(0.2);
      dragNode = null;
    }
    isDraggingCanvas = false; lastMouse = null;
    dom.graphCanvas.style.cursor = hoveredNode ? "pointer" : "grab";

    // Clean click on a node = navigate
    if (!didDrag && clickedNode) {
      closeGraph();
      openNote(clickedNode.path);
    }
    dragStartPos = null; didDrag = false;
  };

  dom.graphCanvas.ondblclick = e => {
    const rect = dom.graphCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const node = getMouseNode(mx, my);
    if (node && node.pinned) {
      node.pinned = false;
      reheat(0.3);
    }
  };

  dom.graphCanvas.onclick = null;

  // Zoom centered on a canvas point (keeps mouse position steady)
  function zoomAt(canvasX, canvasY, factor) {
    const newZoom = Math.max(0.15, Math.min(6, zoom * factor));
    panX += canvasX / newZoom - canvasX / zoom;
    panY += canvasY / newZoom - canvasY / zoom;
    zoom = newZoom;
  }

  dom.graphCanvas.onwheel = e => {
    e.preventDefault();
    const rect = dom.graphCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.96 : 1.04;
    zoomAt(mx, my, factor);
  };

  // Recenter: fit all nodes in view
  function recenterFn() {
    if (!state.graphNodes || !state.graphNodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of state.graphNodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = (maxX - minX) || 100, spanY = (maxY - minY) || 100;
    zoom = Math.min(W / (spanX + 80), H / (spanY + 80), 2);
    panX = W / 2 / zoom - cx;
    panY = H / 2 / zoom - cy;
  }
  state.graphRecenter = recenterFn;
  state.graphZoomAt = zoomAt;
  setTimeout(recenterFn, 1500);
}

export function closeGraph() {
  dom.graphOverlay.classList.remove("visible");
  dom.graphTooltip.classList.remove("visible");
  if (state.graphAnimFrame) { cancelAnimationFrame(state.graphAnimFrame); state.graphAnimFrame = null; }
  dom.cmdInput.placeholder = "Search, /commands, or ?ask AI...";
  state.graphSearchQuery = "";
  closeCmdBar();
}

export function initGraph_() {
  document.getElementById("sidebar-graph-btn").addEventListener("click", openGraph);
  document.getElementById("graph-recenter").addEventListener("click", () => {
    if (state.graphRecenter) state.graphRecenter();
  });
  document.getElementById("graph-zoom-in").addEventListener("click", () => {
    if (state.graphZoomAt) {
      const c = dom.graphCanvas;
      state.graphZoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.25);
    }
  });
  document.getElementById("graph-zoom-out").addEventListener("click", () => {
    if (state.graphZoomAt) {
      const c = dom.graphCanvas;
      state.graphZoomAt(c.clientWidth / 2, c.clientHeight / 2, 0.8);
    }
  });
  document.getElementById("graph-close").addEventListener("click", closeGraph);
}
