import { useState, useCallback, useRef, useEffect } from "react";

const CONFIG = {
  CLIENT_ID: "557787515939-unu0a0jeuge7aad358qridceu8uqchd2.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
  FOLDER_NAME: "ProjectManager",
  ROLES_FILE: "_roles.json",
  // ID da pasta compartilhada no Drive do owner (todos os usuários leem/escrevem aqui)
  SHARED_FOLDER_ID: "1HdeTTWgZisScFSJbps_dLVohmRGCsMwT",
  OWNER_EMAIL: "luiz.bordignon@segmob.com.br",
};

const PRIORITIES = { low: { label: "Baixa", color: "#22c55e" }, medium: { label: "Média", color: "#f59e0b" }, high: { label: "Alta", color: "#ef4444" } };
const STATUS_MAP = { backlog: "Backlog", active: "Em Andamento", review: "Em Revisão", done: "Concluído" };
const ROLES = { admin: { label: "Administrador", color: "#7c3aed", icon: "👑" }, editor: { label: "Editor", color: "#3b82f6", icon: "✏️" }, viewer: { label: "Visualização", color: "#6b7280", icon: "👁" } };

// ═══════════════════════════════════════════════════════════════
// ▸ GOOGLE DRIVE SERVICE
// ═══════════════════════════════════════════════════════════════
class DriveService {
  constructor() { this.token = null; this.folderId = null; this.user = null; }
  setToken(token) { this.token = token; }

  async fetchApi(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${this.token}`, ...options.headers } });
    if (!res.ok) { const err = await res.text().catch(() => ""); throw new Error(`Drive API ${res.status}: ${err}`); }
    return res.json();
  }

  async getUserInfo() {
    const data = await this.fetchApi("https://www.googleapis.com/oauth2/v2/userinfo");
    this.user = { id: data.id, name: data.name, email: data.email, picture: data.picture };
    return this.user;
  }

  async getOrCreateFolder() {
    if (this.folderId) return this.folderId;
    // Se há uma pasta compartilhada configurada, usa ela diretamente
    if (CONFIG.SHARED_FOLDER_ID) { this.folderId = CONFIG.SHARED_FOLDER_ID; return this.folderId; }
    const q = `name='${CONFIG.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (list.files?.length > 0) { this.folderId = list.files[0].id; return this.folderId; }
    const folder = await this.fetchApi("https://www.googleapis.com/drive/v3/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: CONFIG.FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }) });
    this.folderId = folder.id;
    return this.folderId;
  }

  async getOrCreateProjectFolder(projectName) {
    const rootId = await this.getOrCreateFolder();
    const safeName = (projectName || "Projeto").trim().replace(/[/\\:*?"<>|]/g, "").trim() || "Projeto";
    const q = `'${rootId}' in parents and name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (list.files?.length > 0) return list.files[0].id;
    const folder = await this.fetchApi("https://www.googleapis.com/drive/v3/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: safeName, mimeType: "application/vnd.google-apps.folder", parents: [rootId] }) });
    return folder.id;
  }

  async getOrCreateDocumentsFolder(projectFolderId) {
    const q = `'${projectFolderId}' in parents and name='Documents' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (list.files?.length > 0) return list.files[0].id;
    const folder = await this.fetchApi("https://www.googleapis.com/drive/v3/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Documents", mimeType: "application/vnd.google-apps.folder", parents: [projectFolderId] }) });
    return folder.id;
  }

  async getOrCreateTeamFolder() {
    const rootId = await this.getOrCreateFolder();
    const q = `'${rootId}' in parents and name='Team' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (list.files?.length > 0) return list.files[0].id;
    const folder = await this.fetchApi("https://www.googleapis.com/drive/v3/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Team", mimeType: "application/vnd.google-apps.folder", parents: [rootId] }) });
    return folder.id;
  }

  async loadTeam() {
    try {
      const teamFolderId = await this.getOrCreateTeamFolder();
      const q = `'${teamFolderId}' in parents and name='team.json' and trashed=false`;
      const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
      if (!list.files?.length) return [];
      const content = await this.readFile(list.files[0].id);
      return JSON.parse(content);
    } catch { return []; }
  }

  async saveTeam(team) {
    const teamFolderId = await this.getOrCreateTeamFolder();
    const q = `'${teamFolderId}' in parents and name='team.json' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
    const existingId = list.files?.[0]?.id || null;
    const content = JSON.stringify(team, null, 2);
    const metadata = { name: "team.json", mimeType: "application/json" };
    if (!existingId) metadata.parents = [teamFolderId];
    await this._multipartUpload(metadata, content, "application/json", existingId);
  }

  async _multipartUpload(metadata, content, contentType, existingFileId = null) {
    const boundary = "---pm_boundary_" + Date.now();
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name";
    const res = await fetch(url, { method: existingFileId ? "PATCH" : "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    if (!res.ok) { const err = await res.text().catch(() => ""); throw new Error(`Upload falhou ${res.status}: ${err}`); }
    return res.json();
  }

  async listMdFiles() {
    const rootId = await this.getOrCreateFolder();
    const foldersQ = `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const foldersRes = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(foldersQ)}&fields=files(id,name)`);
    const projectFolders = (foldersRes.files || []).filter(f => f.name !== "Team");
    const allResults = await Promise.all(projectFolders.map(async pf => {
      const q = `'${pf.id}' in parents and name contains '.md' and trashed=false`;
      const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`);
      return (list.files || []).filter(f => f.name.endsWith(".md")).map(f => ({ ...f, projectFolderId: pf.id }));
    }));
    return allResults.flat();
  }

  async readFile(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error("Erro ao ler arquivo");
    return res.text();
  }

  async saveFile(filename, content, existingFileId = null, projectFolderId = null) {
    const metadata = { name: filename, mimeType: "text/plain" };
    if (!existingFileId) metadata.parents = [projectFolderId || await this.getOrCreateFolder()];
    return this._multipartUpload(metadata, content, "text/plain", existingFileId);
  }

  async deleteFile(fileId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${this.token}` } });
  }

  async saveImage(dataUrl, existingFileId = null, projectFolderId = null) {
    const [header, base64] = dataUrl.split(",");
    const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const imageBlob = new Blob([bytes], { type: mimeType });
    const boundary = "---pm_img_" + Date.now();
    const metadata = { name: "cover", mimeType };
    if (!existingFileId && projectFolderId) metadata.parents = [projectFolderId];
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      imageBlob,
      `\r\n--${boundary}--`,
    ]);
    const url = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;
    const res = await fetch(url, { method: existingFileId ? "PATCH" : "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    if (!res.ok) { const err = await res.text().catch(() => ""); throw new Error(`Imagem ${res.status}: ${err}`); }
    return (await res.json()).id;
  }

  async readFileAsDataUrl(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error("Erro ao ler imagem");
    const blob = await res.blob();
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = e => resolve(e.target.result); reader.onerror = reject; reader.readAsDataURL(blob); });
  }

  async getRolesFileId() {
    const folderId = await this.getOrCreateFolder();
    const q = `'${folderId}' in parents and name='${CONFIG.ROLES_FILE}' and trashed=false`;
    const list = await this.fetchApi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
    return list.files?.[0]?.id || null;
  }

  async loadRoles() {
    const fileId = await this.getRolesFileId();
    if (!fileId) return {};
    try { const content = await this.readFile(fileId); return JSON.parse(content); } catch { return {}; }
  }

  async saveRoles(roles) {
    const fileId = await this.getRolesFileId();
    const content = JSON.stringify(roles, null, 2);
    const metadata = { name: CONFIG.ROLES_FILE, mimeType: "application/json" };
    if (!fileId) { const folderId = await this.getOrCreateFolder(); metadata.parents = [folderId]; }
    await this._multipartUpload(metadata, content, "application/json", fileId);
  }

  async shareFolder(email, role = "reader") {
    const folderId = await this.getOrCreateFolder();
    await this.fetchApi(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "user", role, emailAddress: email }) });
  }
}

const drive = new DriveService();

// ═══════════════════════════════════════════════════════════════
// ▸ SCHEDULE CALCULATOR
// ═══════════════════════════════════════════════════════════════
function calcProjectSchedule(project) {
  if (!project.startDate || !project.tasks?.length) return { endDate: null, tasksWithDates: [] };
  const start = new Date(project.startDate + "T12:00:00");
  const tasks = project.tasks;
  const taskById = Object.fromEntries(tasks.map(t => [String(t.id), t]));
  const endCache = {};

  function taskEnd(id) {
    const sid = String(id);
    if (endCache[sid] !== undefined) return endCache[sid];
    const t = taskById[sid];
    if (!t) return start;
    let tStart = start;
    if (t.ancestorId && taskById[String(t.ancestorId)]) tStart = taskEnd(t.ancestorId);
    const offset = (t.offsetWeeks || 0) * 7 * 86400000;
    const end = new Date(tStart.getTime() + offset + (t.weeks || 1) * 7 * 86400000);
    endCache[sid] = end;
    return end;
  }

  tasks.forEach(t => taskEnd(t.id));

  const tasksWithDates = tasks.map(t => {
    const tEnd = endCache[String(t.id)];
    const tStart = new Date(tEnd.getTime() - (t.weeks || 1) * 7 * 86400000);
    return { ...t, _start: tStart, _end: tEnd, offsetWeeks: t.offsetWeeks || 0 };
  });

  const endDate = new Date(Math.max(...tasksWithDates.map(t => t._end.getTime())));
  return { endDate, tasksWithDates };
}

// ═══════════════════════════════════════════════════════════════
// ▸ MARKDOWN CONVERTERS
// ═══════════════════════════════════════════════════════════════
function projectToMd(p) {
  const schedule = calcProjectSchedule(p);
  const done = p.tasks.filter(t => t.done).length;
  const total = p.tasks.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const totalCost = p.tasks.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  let md = `# ${p.name}\n\n`;
  md += `> id: ${p.id}\n\n`;
  md += `| Campo | Valor |\n|---|---|\n`;
  md += `| **Status** | ${STATUS_MAP[p.status] || p.status} |\n`;
  md += `| **Prioridade** | ${PRIORITIES[p.priority]?.label || p.priority} |\n`;
  md += `| **Progresso** | ${pct}% (${done}/${total}) |\n`;
  if (p.startDate) md += `| **Início** | ${p.startDate} |\n`;
  if (schedule.endDate) md += `| **Fim Estimado** | ${schedule.endDate.toISOString().split("T")[0]} |\n`;
  if (totalCost > 0) md += `| **Custo Total** | ${totalCost} |\n`;
  md += `| **Criado em** | ${p.createdAt} |\n`;
  if (p.imageFileId) md += `| **Image** | ${p.imageFileId} |\n`;
  if (p.description) md += `\n## Descrição\n\n${p.description}\n`;
  if (p.tasks.length > 0) {
    md += `\n## Tarefas\n\n`;
    p.tasks.forEach(t => {
      const meta = { id: String(t.id), r: t.rev || 1 };
      if (t.weeks) meta.w = t.weeks;
      if (t.assignee) meta.who = t.assignee;
      if (t.cost) meta.cost = t.cost;
      if (t.ancestorId) meta.anc = String(t.ancestorId);
      if (t.offsetWeeks) meta.off = t.offsetWeeks;
      md += `- [${t.done ? "x" : " "}] ${t.text} <!-- ${JSON.stringify(meta)} -->\n`;
    });
  }
  return md;
}

function mdToProject(md) {
  try {
    const nameMatch = md.match(/^# (.+)$/m);
    const idMatch = md.match(/> id: (.+)/);
    const statusMatch = md.match(/\*\*Status\*\*\s*\|\s*(.+?)\s*\|/);
    const prioMatch = md.match(/\*\*Prioridade\*\*\s*\|\s*(.+?)\s*\|/);
    const startMatch = md.match(/\*\*Início\*\*\s*\|\s*(.+?)\s*\|/);
    const dueMatch = md.match(/\*\*Prazo\*\*\s*\|\s*(.+?)\s*\|/); // legacy fallback
    const createdMatch = md.match(/\*\*Criado em\*\*\s*\|\s*(.+?)\s*\|/);
    const imageFileIdMatch = md.match(/\*\*Image\*\*\s*\|\s*(.+?)\s*\|/);
    const descMatch = md.match(/## Descrição\s*\n\n([\s\S]*?)(?=\n## |$)/);
    const taskMatches = [...md.matchAll(/^- \[(x| )\] (.+?)(?:\s+<!-- (\{.+\}) -->)?$/gm)];
    const statusKey = Object.entries(STATUS_MAP).find(([, v]) => v === statusMatch?.[1]?.trim())?.[0] || "backlog";
    const prioKey = Object.entries(PRIORITIES).find(([, v]) => v.label === prioMatch?.[1]?.trim())?.[0] || "medium";
    return {
      id: idMatch?.[1]?.trim() || String(Date.now()),
      name: nameMatch?.[1] || "Projeto Importado",
      image: null,
      imageFileId: imageFileIdMatch?.[1]?.trim() || null,
      description: descMatch?.[1]?.trim() || "",
      priority: prioKey,
      status: statusKey,
      startDate: startMatch?.[1]?.trim() || dueMatch?.[1]?.trim() || "",
      createdAt: createdMatch?.[1]?.trim() || new Date().toISOString().split("T")[0],
      tasks: taskMatches.map((m, i) => {
        const rawText = m[2].trim();
        let meta = {};
        const hasMeta = !!m[3];
        if (hasMeta) { try { meta = JSON.parse(m[3]); } catch {} }
        let text = rawText, legacyRev = 1;
        if (!hasMeta) {
          const rv = rawText.match(/^(.*) \[r:(\d+)\]$/);
          if (rv) { text = rv[1]; legacyRev = parseInt(rv[2]); }
        }
        return {
          id: meta.id || String(Date.now() + i),
          text,
          done: m[1] === "x",
          rev: meta.r || legacyRev,
          weeks: meta.w || null,
          assignee: meta.who || null,
          cost: meta.cost || null,
          ancestorId: meta.anc || null,
          offsetWeeks: meta.off || 0,
        };
      }),
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// ▸ UI COMPONENTS
// ═══════════════════════════════════════════════════════════════
const font = "'DM Sans', sans-serif";

function CircularProgress({ percent, size = 44 }) {
  const r = (size - 6) / 2, circ = 2 * Math.PI * r, offset = circ - (percent / 100) * circ;
  const color = percent === 100 ? "#22c55e" : percent >= 50 ? "#3b82f6" : percent > 0 ? "#f59e0b" : "#d1d5db";
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#e5e7eb" strokeWidth="3" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3" strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: "stroke-dashoffset .4s, stroke .3s" }} />
      <text x={size/2} y={size/2} textAnchor="middle" dy=".35em" style={{ transform: "rotate(90deg)", transformOrigin: "center", fontSize: size*.26, fontWeight: 600, fill: "#374151", fontFamily: font }}>{percent}%</text>
    </svg>
  );
}

function Toast({ message, type }) {
  if (!message) return null;
  const bg = type === "error" ? "#fef2f2" : type === "success" ? "#f0fdf4" : "#eff6ff";
  const border = type === "error" ? "#fecaca" : type === "success" ? "#bbf7d0" : "#bfdbfe";
  const color = type === "error" ? "#b91c1c" : type === "success" ? "#15803d" : "#1d4ed8";
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, background: bg, border: `1px solid ${border}`, color, padding: "12px 20px", borderRadius: 12, fontSize: 13, fontFamily: font, fontWeight: 500, zIndex: 2000, boxShadow: "0 4px 12px rgba(0,0,0,.08)", maxWidth: 360, animation: "slideIn .3s ease" }}>
      {message}
    </div>
  );
}

function ProjectCard({ project, onClick, onDelete, canDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const total = project.tasks.length, done = project.tasks.filter(t => t.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const schedule = calcProjectSchedule(project);
  const overdue = schedule.endDate && schedule.endDate < new Date() && percent < 100;
  const totalCost = project.tasks.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const paidCost = project.tasks.filter(t => t.done).reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const pendingCost = totalCost - paidCost;
  return (
    <div onClick={onClick} style={{ background: "#fff", borderRadius: 16, overflow: "hidden", cursor: "pointer", position: "relative", display: "flex", flexDirection: "column", border: "1px solid #e8eaed", transition: "box-shadow .2s, transform .15s", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,.08)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,.04)"; e.currentTarget.style.transform = "translateY(0)"; }}>
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 2 }}><CircularProgress percent={percent} /></div>
      {canDelete && !confirmDelete && (
        <button onClick={e => { e.stopPropagation(); setConfirmDelete(true); }} style={{ position: "absolute", top: 10, left: 10, zIndex: 2, background: "rgba(255,255,255,.85)", border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 14, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}
          onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#9ca3af"}>✕</button>
      )}
      {canDelete && confirmDelete && (
        <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, left: 8, zIndex: 3, background: "#fff", border: "1px solid #fecaca", borderRadius: 10, padding: "8px 10px", boxShadow: "0 4px 12px rgba(0,0,0,.12)", display: "flex", flexDirection: "column", gap: 6, minWidth: 140 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#374151", fontFamily: font }}>Excluir projeto?</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={e => { e.stopPropagation(); onDelete(project.id); }} style={{ flex: 1, padding: "5px 0", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Excluir</button>
            <button onClick={e => { e.stopPropagation(); setConfirmDelete(false); }} style={{ flex: 1, padding: "5px 0", background: "#f3f4f6", color: "#6b7280", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Cancelar</button>
          </div>
        </div>
      )}
      <div style={{ aspectRatio: "16/10", background: project.image ? `url(${project.image}) center/cover` : "linear-gradient(135deg,#f0f1f3,#e2e4e8)", display: "flex", alignItems: "center", justifyContent: "center", color: "#b0b5bd", fontSize: 36, borderBottom: "1px solid #f0f0f0" }}>
        {!project.image && "📁"}
      </div>
      <div style={{ padding: "14px 16px 16px" }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font }}>{project.name}</h3>
        {totalCost > 0 && (
          <div style={{ marginTop: 7, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            <div style={{ background: "#eff6ff", borderRadius: 7, padding: "4px 6px", textAlign: "center" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#3b82f6", fontFamily: font, textTransform: "uppercase", letterSpacing: ".3px" }}>Total</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", fontFamily: font }}>{totalCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</div>
            </div>
            <div style={{ background: "#f0fdf4", borderRadius: 7, padding: "4px 6px", textAlign: "center" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#22c55e", fontFamily: font, textTransform: "uppercase", letterSpacing: ".3px" }}>Pago</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d", fontFamily: font }}>{paidCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</div>
            </div>
            <div style={{ background: "#fff7ed", borderRadius: 7, padding: "4px 6px", textAlign: "center" }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: "#f59e0b", fontFamily: font, textTransform: "uppercase", letterSpacing: ".3px" }}>A pagar</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309", fontFamily: font }}>{pendingCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</div>
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6, background: PRIORITIES[project.priority].color + "18", color: PRIORITIES[project.priority].color, fontFamily: font }}>{PRIORITIES[project.priority].label}</span>
          <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6, background: "#f3f4f6", color: "#6b7280", fontFamily: font }}>{STATUS_MAP[project.status]}</span>
          {overdue && <span style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", fontFamily: font }}>Atrasado</span>}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af", fontFamily: font }}>
          {total > 0 ? `${done}/${total} tarefas` : "Sem tarefas"}
          {project.startDate && <span style={{ marginLeft: 8 }}>· Início {new Date(project.startDate + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</span>}
          {schedule.endDate && <span style={{ marginLeft: 8 }}>· Fim {schedule.endDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</span>}
        </div>
      </div>
    </div>
  );
}

function ProjectModal({ project, onClose, onSave, onCancelNew, canEdit, isNew, docsUrl, team }) {
  const [data, setData] = useState({ ...project, tasks: project.tasks.map(t => ({ ...t })) });
  const [newTaskData, setNewTaskData] = useState({ text: "", weeks: null, assignee: null, cost: null, ancestorId: null });
  const [startDateError, setStartDateError] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [weeksErrors, setWeeksErrors] = useState(new Set());
  const [dragTaskId, setDragTaskId] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const fileRef = useRef(), taskRef = useRef();

  const total = data.tasks.length, done = data.tasks.filter(t => t.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const schedule = calcProjectSchedule(data);
  const totalCost = data.tasks.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const paidCost = data.tasks.filter(t => t.done).reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const pendingCost = totalCost - paidCost;
  const set = (k, v) => setData(d => ({ ...d, [k]: v }));

  const updateTask = (id, field, value) => {
    if (field === "weeks" && value) setWeeksErrors(prev => { const n = new Set(prev); n.delete(id); return n; });
    set("tasks", data.tasks.map(t => t.id === id ? { ...t, [field]: value } : t));
  };

  const handleCancel = () => isNew ? onCancelNew() : onClose();

  const handleSave = () => {
    if (!data.startDate) { setStartDateError("Data de início é obrigatória"); return; }
    setStartDateError("");
    let tasksWithRev;
    if (isNew) {
      tasksWithRev = data.tasks.map(t => ({ ...t, rev: 1, _pendingRev: undefined }));
    } else {
      const maxRev = data.tasks.filter(t => !t._pendingRev).reduce((m, t) => Math.max(m, t.rev || 1), 1);
      const nextRev = maxRev + 1;
      tasksWithRev = data.tasks.map(t => t._pendingRev ? { ...t, rev: nextRev, _pendingRev: undefined } : { ...t, rev: t.rev || 1 });
    }
    onSave({ ...data, tasks: tasksWithRev, _isNew: undefined });
  };

  const addTask = () => {
    const t = newTaskData.text.trim();
    if (!t) return;
    set("tasks", [...data.tasks, { id: String(Date.now()), text: t, done: false, rev: null, weeks: newTaskData.weeks, assignee: newTaskData.assignee, cost: newTaskData.cost, ancestorId: newTaskData.ancestorId, _pendingRev: !isNew }]);
    setNewTaskData({ text: "", weeks: null, assignee: null, cost: null, ancestorId: null });
    taskRef.current?.focus();
  };

  const toggleTask = id => {
    const task = data.tasks.find(t => t.id === id);
    if (!task.done && !task.weeks) {
      setExpandedTaskId(id);
      setWeeksErrors(prev => new Set([...prev, id]));
      return;
    }
    setWeeksErrors(prev => { const n = new Set(prev); n.delete(id); return n; });
    set("tasks", data.tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  const deleteTask = id => {
    set("tasks", data.tasks.filter(t => t.id !== id));
    if (expandedTaskId === id) setExpandedTaskId(null);
  };

  const handleTaskDragStart = (e, taskId) => {
    setDragTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  };
  const handleTaskDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };
  const handleTaskDrop = (e, dropIdx) => {
    e.preventDefault();
    if (dragTaskId == null) return;
    const fromIdx = data.tasks.findIndex(t => t.id === dragTaskId);
    if (fromIdx === -1 || fromIdx === dropIdx) { setDragTaskId(null); setDragOverIdx(null); return; }
    const tasks = [...data.tasks];
    const [moved] = tasks.splice(fromIdx, 1);
    tasks.splice(dropIdx, 0, moved);
    set("tasks", tasks);
    setDragTaskId(null);
    setDragOverIdx(null);
  };
  const handleTaskDragEnd = () => { setDragTaskId(null); setDragOverIdx(null); };

  const handleImage = e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = ev => set("image", ev.target.result); r.readAsDataURL(f); };

  const inputStyle = { width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: font, color: "#1a1a1a", outline: "none", background: "#fafafa", boxSizing: "border-box" };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 6, display: "block", fontFamily: font, textTransform: "uppercase", letterSpacing: ".5px" };
  const smallInput = { padding: "6px 8px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, fontFamily: font, color: "#1a1a1a", outline: "none", background: "#fff", boxSizing: "border-box", width: "100%" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: 960, maxHeight: "94vh", overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,.12)", position: "relative", display: "flex", flexDirection: "column" }}>
        {/* Quick-close X */}
        <button onClick={handleCancel} title="Fechar" style={{ position: "absolute", top: 14, right: 14, zIndex: 20, background: "rgba(255,255,255,.92)", border: "none", borderRadius: "50%", width: 30, height: 30, cursor: "pointer", fontSize: 16, color: "#6b7280", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px rgba(0,0,0,.12)", backdropFilter: "blur(4px)" }}
          onMouseEnter={e => { e.currentTarget.style.background = "#fee2e2"; e.currentTarget.style.color = "#ef4444"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,.92)"; e.currentTarget.style.color = "#6b7280"; }}>✕</button>
        {/* Image banner */}
        <div onClick={() => canEdit && fileRef.current?.click()} style={{ height: 160, background: data.image ? `url(${data.image}) center/cover` : "linear-gradient(135deg,#f0f1f3,#e2e4e8)", display: "flex", alignItems: "center", justifyContent: "center", cursor: canEdit ? "pointer" : "default", position: "relative", borderRadius: "20px 20px 0 0" }}>
          {canEdit && <div style={{ background: "rgba(255,255,255,.85)", borderRadius: 10, padding: "8px 16px", fontSize: 13, color: "#6b7280", fontFamily: font, fontWeight: 500, backdropFilter: "blur(4px)" }}>📷 {data.image ? "Alterar imagem" : "Adicionar imagem"}</div>}
          <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} style={{ display: "none" }} />
          <div style={{ position: "absolute", top: 16, right: 52 }}><CircularProgress percent={percent} size={52} /></div>
          {docsUrl && (
            <a href={docsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              style={{ position: "absolute", top: 14, left: 14, display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "#1d4ed8", textDecoration: "none", padding: "5px 10px", borderRadius: 8, background: "rgba(255,255,255,.88)", backdropFilter: "blur(4px)", border: "1px solid rgba(191,219,254,.8)" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(219,234,254,.95)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,.88)"}>
              📄 Documents
            </a>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }} className="auto-scroll">
          {/* Static fields */}
          <div style={{ flexShrink: 0, padding: "24px 28px 0" }}>
          {/* Name */}
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Nome do Projeto</label>
            {canEdit
              ? <input value={data.name} onChange={e => set("name", e.target.value)} style={{ ...inputStyle, fontSize: 18, fontWeight: 600, background: "transparent", border: "1px solid transparent", padding: "6px 0" }} onFocus={e => e.target.style.borderColor = "#3b82f6"} onBlur={e => e.target.style.borderColor = "transparent"} />
              : <p style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "#1a1a1a", fontFamily: font }}>{data.name}</p>}
          </div>

          {/* Priority + Status */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div><label style={labelStyle}>Prioridade</label>
              {canEdit ? <select value={data.priority} onChange={e => set("priority", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                : <p style={{ margin: 0, fontSize: 14, fontFamily: font }}>{PRIORITIES[data.priority].label}</p>}
            </div>
            <div><label style={labelStyle}>Status</label>
              {canEdit ? <select value={data.status} onChange={e => set("status", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>{Object.entries(STATUS_MAP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                : <p style={{ margin: 0, fontSize: 14, fontFamily: font }}>{STATUS_MAP[data.status]}</p>}
            </div>
          </div>

          {/* Dates */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div>
              <label style={{ ...labelStyle, color: startDateError ? "#ef4444" : "#6b7280" }}>Início *</label>
              {canEdit
                ? <input type="date" value={data.startDate || ""} onChange={e => { set("startDate", e.target.value); setStartDateError(""); }} style={{ ...inputStyle, cursor: "pointer", borderColor: startDateError ? "#ef4444" : undefined }} />
                : <p style={{ margin: 0, fontSize: 14, fontFamily: font }}>{data.startDate || "—"}</p>}
              {startDateError && <p style={{ margin: "4px 0 0", fontSize: 11, color: "#ef4444", fontFamily: font }}>{startDateError}</p>}
            </div>
            <div>
              <label style={labelStyle}>Fim Estimado</label>
              <p style={{ margin: 0, padding: "10px 0", fontSize: 14, fontFamily: font, color: schedule.endDate ? "#374151" : "#c0c4cc" }}>
                {schedule.endDate ? schedule.endDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
              </p>
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: 24 }}>
            <label style={labelStyle}>Descrição</label>
            {canEdit
              ? <textarea value={data.description} onChange={e => set("description", e.target.value)} rows={3} placeholder="Descreva o objetivo do projeto..." style={{ ...inputStyle, resize: "vertical", minHeight: 70 }} />
              : <p style={{ margin: 0, fontSize: 14, color: "#374151", fontFamily: font, whiteSpace: "pre-wrap" }}>{data.description || "Sem descrição"}</p>}
          </div>
          </div>{/* end static fields */}

          {/* Tasks */}
          <div style={{ display: "flex", flexDirection: "column", padding: "0 28px", marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexShrink: 0 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Tarefas ({done}/{total})</label>
              {totalCost > 0 && (
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", background: "#eff6ff", padding: "2px 8px", borderRadius: 6, fontFamily: font }}>Total {totalCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#15803d", background: "#f0fdf4", padding: "2px 8px", borderRadius: 6, fontFamily: font }}>Pago {paidCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fff7ed", padding: "2px 8px", borderRadius: 6, fontFamily: font }}>A pagar {pendingCost.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
                </div>
              )}
            </div>
            {canEdit && (
              <div style={{ border: "1.5px dashed #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 14, background: "#fafafa", flexShrink: 0 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input ref={taskRef} value={newTaskData.text} onChange={e => setNewTaskData(d => ({ ...d, text: e.target.value }))} onKeyDown={e => e.key === "Enter" && addTask()} placeholder="Descrição da tarefa..." style={{ ...inputStyle, flex: 1, marginBottom: 0 }} />
                  <button onClick={addTask} style={{ padding: "10px 20px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font, whiteSpace: "nowrap" }}>+ Adicionar</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 100px", gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Semanas</label>
                    <input type="number" min={1} value={newTaskData.weeks || ""} onChange={e => setNewTaskData(d => ({ ...d, weeks: e.target.value ? Number(e.target.value) : null }))} placeholder="ex: 2" style={smallInput} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Ancestral</label>
                    <select value={newTaskData.ancestorId || ""} onChange={e => setNewTaskData(d => ({ ...d, ancestorId: e.target.value || null }))} style={{ ...smallInput, cursor: "pointer" }}>
                      <option value="">— nenhum —</option>
                      {data.tasks.map(t => <option key={t.id} value={String(t.id)}>{t.text.length > 28 ? t.text.slice(0, 28) + "…" : t.text}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Responsável</label>
                    <select value={newTaskData.assignee || ""} onChange={e => setNewTaskData(d => ({ ...d, assignee: e.target.value || null }))} style={{ ...smallInput, cursor: "pointer" }}>
                      <option value="">— ninguém —</option>
                      {(team || []).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Custo R$</label>
                    <input type="number" min={0} value={newTaskData.cost || ""} onChange={e => setNewTaskData(d => ({ ...d, cost: e.target.value ? Number(e.target.value) : null }))} placeholder="Opcional" style={smallInput} />
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 60, marginBottom: 16 }}>
              {data.tasks.length === 0 && <p style={{ color: "#c0c4cc", fontSize: 13, textAlign: "center", padding: 20, fontFamily: font }}>Nenhuma tarefa</p>}
              {data.tasks.map((task, idx) => {
                const isExpanded = expandedTaskId === task.id;
                const hasWeeksErr = weeksErrors.has(task.id);
                const ancestor = task.ancestorId ? data.tasks.find(t => String(t.id) === String(task.ancestorId)) : null;
                const isDragging = dragTaskId === task.id;
                const isDropTarget = dragOverIdx === idx && dragTaskId !== task.id;
                return (
                  <div key={task.id} draggable={canEdit} onDragStart={e => handleTaskDragStart(e, task.id)} onDragOver={e => handleTaskDragOver(e, idx)} onDrop={e => handleTaskDrop(e, idx)} onDragEnd={handleTaskDragEnd} style={{ borderRadius: 10, border: `1px solid ${isDropTarget ? "#6366f1" : isExpanded ? "#e0e7ff" : "transparent"}`, background: isDragging ? "#e0e7ff" : task.done ? "#f0fdf4" : isExpanded ? "#fafafe" : "#fafafa", overflow: "hidden", flexShrink: 0, opacity: isDragging ? 0.5 : 1, transition: "border-color .15s, opacity .15s", borderTop: isDropTarget ? "2px solid #6366f1" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
                      {canEdit && <div style={{ cursor: "grab", color: "#c0c4cc", fontSize: 14, flexShrink: 0, userSelect: "none", lineHeight: 1 }} title="Arrastar para reordenar">⠿</div>}
                      <div onClick={() => canEdit && toggleTask(task.id)} style={{ width: 20, height: 20, borderRadius: 6, border: task.done ? "none" : "2px solid #d1d5db", background: task.done ? "#22c55e" : "transparent", cursor: canEdit ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#fff", fontSize: 12, fontWeight: 700 }}>{task.done && "✓"}</div>
                      {editingTaskId === task.id && canEdit
                        ? <input autoFocus value={task.text} onChange={e => updateTask(task.id, "text", e.target.value)} onBlur={() => setEditingTaskId(null)} onKeyDown={e => e.key === "Enter" && setEditingTaskId(null)} style={{ flex: 1, fontSize: 14, fontFamily: font, border: "none", outline: "1px solid #3b82f6", borderRadius: 6, padding: "2px 6px", background: "#fff" }} />
                        : <span onClick={() => canEdit && setEditingTaskId(task.id)} style={{ flex: 1, fontSize: 14, color: task.done ? "#86efac" : "#374151", textDecoration: task.done ? "line-through" : "none", fontFamily: font, cursor: canEdit ? "text" : "default" }}>{task.text}</span>
                      }
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        {task.weeks && <span style={{ fontSize: 10, fontWeight: 600, color: "#7c3aed", background: "#f5f3ff", padding: "1px 5px", borderRadius: 4, fontFamily: font }}>{task.weeks}s</span>}
                        {task.assignee && <span style={{ fontSize: 10, color: "#6b7280", fontFamily: font, maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.assignee.split(" ")[0]}</span>}
                        {task.cost > 0 && <span style={{ fontSize: 10, color: "#15803d", fontFamily: font }}>R${Number(task.cost).toLocaleString("pt-BR")}</span>}
                        {(task.rev || task._pendingRev) && <span style={{ fontSize: 10, color: "#d1d5db", fontFamily: font }}>{task._pendingRev ? "·new" : `·r${task.rev}`}</span>}
                        {canEdit && <button onClick={() => setExpandedTaskId(isExpanded ? null : task.id)} style={{ background: "none", border: "none", color: isExpanded ? "#6366f1" : "#9ca3af", cursor: "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}>{isExpanded ? "▲" : "▼"}</button>}
                        {canEdit && <button onClick={() => deleteTask(task.id)} style={{ background: "none", border: "none", color: "#d1d5db", cursor: "pointer", fontSize: 16, padding: "0 2px" }} onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#d1d5db"}>×</button>}
                      </div>
                    </div>
                    {isExpanded && canEdit && (
                      <div style={{ padding: "0 12px 12px", borderTop: "1px solid #e0e7ff" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 2fr 1fr", gap: 8, marginTop: 10 }}>
                          <div>
                            <label style={{ fontSize: 10, fontWeight: 600, color: hasWeeksErr ? "#ef4444" : "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Semanas *</label>
                            <input type="number" min={1} value={task.weeks || ""} onChange={e => updateTask(task.id, "weeks", e.target.value ? Number(e.target.value) : null)} placeholder="ex: 2" style={{ ...smallInput, borderColor: hasWeeksErr ? "#ef4444" : "#e5e7eb" }} />
                            {hasWeeksErr && <p style={{ margin: "2px 0 0", fontSize: 10, color: "#ef4444", fontFamily: font }}>Req. p/ fechar</p>}
                          </div>
                          <div>
                            <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Ancestral</label>
                            <select value={task.ancestorId || ""} onChange={e => updateTask(task.id, "ancestorId", e.target.value || null)} style={{ ...smallInput, cursor: "pointer" }}>
                              <option value="">— nenhum —</option>
                              {data.tasks.filter(t => String(t.id) !== String(task.id)).map(t => (
                                <option key={t.id} value={String(t.id)}>{t.text.length > 24 ? t.text.slice(0, 24) + "…" : t.text}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Responsável</label>
                            <select value={task.assignee || ""} onChange={e => updateTask(task.id, "assignee", e.target.value || null)} style={{ ...smallInput, cursor: "pointer" }}>
                              <option value="">— ninguém —</option>
                              {(team || []).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: 10, fontWeight: 600, color: "#6b7280", fontFamily: font, textTransform: "uppercase", display: "block", marginBottom: 4 }}>Custo R$</label>
                            <input type="number" min={0} value={task.cost || ""} onChange={e => updateTask(task.id, "cost", e.target.value ? Number(e.target.value) : null)} placeholder="Opcional" style={smallInput} />
                          </div>
                        </div>
                        {ancestor && <p style={{ margin: "8px 0 0", fontSize: 11, color: "#6366f1", fontFamily: font }}>⛓ Inicia após: <strong>{ancestor.text}</strong></p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, padding: "16px 28px 24px", borderTop: "1px solid #f0f0f0" }}>
            <span style={{ fontSize: 11, color: "#c0c4cc", fontFamily: font }}>Criado em {data.createdAt}</span>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleCancel} style={{ padding: "10px 22px", background: "#f3f4f6", color: "#6b7280", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font }}>{canEdit ? "Cancelar" : "Fechar"}</button>
              {canEdit && <button onClick={handleSave} style={{ padding: "10px 22px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Salvar</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ▸ GANTT CHART
// ═══════════════════════════════════════════════════════════════
function GanttChart({ projects, onClose, onUpdateProject }) {
  const [localProjects, setLocalProjects] = useState(projects);
  const [dragState, setDragState] = useState(null); // { projectId, taskId, startX, origOffset, containerWidth, totalMs }
  const [pendingSaves, setPendingSaves] = useState(new Set());
  const [colWidth, setColWidth] = useState(210);
  const [resizing, setResizing] = useState(null); // { startX, origWidth }
  const [ganttFilter, setGanttFilter] = useState("all");

  // Sync from parent when not dragging
  useEffect(() => { if (!dragState) setLocalProjects(projects); }, [projects, dragState]);

  const STATUS_ORDER = { active: 0, review: 1, backlog: 2, done: 3 };
  const projectsData = localProjects
    .filter(p => p.startDate)
    .filter(p => ganttFilter === "all" ? true : p.status === ganttFilter)
    .map(p => ({ ...p, schedule: calcProjectSchedule(p) }))
    .filter(p => p.schedule.endDate)
    .sort((a, b) => {
      const sA = STATUS_ORDER[a.status] ?? 9, sB = STATUS_ORDER[b.status] ?? 9;
      if (sA !== sB) return sA - sB;
      const pctA = a.tasks.length === 0 ? 0 : a.tasks.filter(t => t.done).length / a.tasks.length;
      const pctB = b.tasks.length === 0 ? 0 : b.tasks.filter(t => t.done).length / b.tasks.length;
      return pctB - pctA;
    });

  const today = new Date();
  const allDates = projectsData.flatMap(p => [new Date(p.startDate + "T12:00:00"), p.schedule.endDate]);
  const minDate = allDates.length ? new Date(Math.min(...allDates.map(d => d.getTime()), today.getTime())) : new Date(today);
  const maxDate = allDates.length ? new Date(Math.max(...allDates.map(d => d.getTime()), today.getTime())) : new Date(today);
  minDate.setDate(minDate.getDate() - 5);
  maxDate.setDate(maxDate.getDate() + 10);
  const totalMs = maxDate.getTime() - minDate.getTime();
  const getPct = d => Math.max(0, Math.min(100, ((new Date(typeof d === "string" ? d + "T12:00:00" : d).getTime() - minDate.getTime()) / totalMs) * 100));

  const months = [];
  const cur = new Date(minDate); cur.setDate(1);
  while (cur <= maxDate) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

  const todayPct = getPct(today);
  const STATUS_COLORS = { backlog: "#9ca3af", active: "#3b82f6", review: "#f59e0b", done: "#22c55e" };

  useEffect(() => { const h = e => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);

  // Column resize
  const handleResizeStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({ startX: e.clientX, origWidth: colWidth });
  };
  useEffect(() => {
    if (!resizing) return;
    const handleMove = e => { const newW = Math.max(120, Math.min(500, resizing.origWidth + (e.clientX - resizing.startX))); setColWidth(newW); };
    const handleUp = () => setResizing(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [resizing]);

  const handleDragStart = (e, projectId, taskId, containerEl) => {
    e.preventDefault();
    const proj = localProjects.find(p => p.id === projectId);
    const task = proj?.tasks.find(t => String(t.id) === String(taskId));
    if (!task || !containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    setDragState({ projectId, taskId, startX: e.clientX, origOffset: task.offsetWeeks || 0, containerWidth: rect.width, totalMs });
  };

  useEffect(() => {
    if (!dragState) return;
    const handleMove = e => {
      const dx = e.clientX - dragState.startX;
      const msPerPx = dragState.totalMs / dragState.containerWidth;
      const deltaMs = dx * msPerPx;
      const deltaWeeks = Math.round(deltaMs / (7 * 86400000));
      const newOffset = dragState.origOffset + deltaWeeks;
      setLocalProjects(prev => prev.map(p => p.id === dragState.projectId
        ? { ...p, tasks: p.tasks.map(t => String(t.id) === String(dragState.taskId) ? { ...t, offsetWeeks: newOffset } : t) }
        : p
      ));
    };
    const handleUp = e => {
      const dx = e.clientX - dragState.startX;
      const msPerPx = dragState.totalMs / dragState.containerWidth;
      const deltaMs = dx * msPerPx;
      const deltaWeeks = Math.round(deltaMs / (7 * 86400000));
      const newOffset = dragState.origOffset + deltaWeeks;
      if (deltaWeeks !== 0 && onUpdateProject) {
        const proj = localProjects.find(p => p.id === dragState.projectId);
        if (proj) {
          const updated = { ...proj, tasks: proj.tasks.map(t => String(t.id) === String(dragState.taskId) ? { ...t, offsetWeeks: newOffset } : t) };
          setPendingSaves(prev => new Set([...prev, proj.id]));
          onUpdateProject(updated).finally(() => setPendingSaves(prev => { const n = new Set(prev); n.delete(proj.id); return n; }));
        }
      }
      setDragState(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => { window.removeEventListener("mousemove", handleMove); window.removeEventListener("mouseup", handleUp); };
  }, [dragState, localProjects, onUpdateProject]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: "12px 16px" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: "98vw", maxHeight: "96vh", overflow: "hidden", boxShadow: "0 24px 48px rgba(0,0,0,.18)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 28px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1a1a1a", fontFamily: font }}>Cronograma · Gantt</h2>
              <div style={{ display: "flex", background: "#f3f4f6", borderRadius: 8, padding: 2 }}>
                {[["all", "Todos"], ["active", "Ativos"], ["review", "Revisão"], ["backlog", "Backlog"], ["done", "Concluídos"]].map(([k, l]) => (
                  <button key={k} onClick={() => setGanttFilter(k)} style={{ padding: "4px 10px", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: font, background: ganttFilter === k ? "#fff" : "transparent", color: ganttFilter === k ? "#1a1a1a" : "#9ca3af", boxShadow: ganttFilter === k ? "0 1px 3px rgba(0,0,0,.06)" : "none", transition: "all .15s" }}>{l}</button>
                ))}
              </div>
            </div>
            <p style={{ margin: "3px 0 0", fontSize: 13, color: "#9ca3af", fontFamily: font }}>
              {projectsData.length} projeto(s)
              {pendingSaves.size > 0 && <span style={{ marginLeft: 8, color: "#f59e0b" }}>· Salvando...</span>}
              <span style={{ marginLeft: 12, fontSize: 11, color: "#b0b5bd" }}>Arraste as tarefas para ajustar a linha do tempo</span>
            </p>
          </div>
          <button onClick={onClose} style={{ background: "#f3f4f6", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: "#6b7280", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>×</button>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {projectsData.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", fontFamily: font }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📅</div>
              <p style={{ color: "#9ca3af", fontSize: 15 }}>Nenhum projeto com data de início definida</p>
            </div>
          ) : (
            <div style={{ minWidth: 700 }}>
              {/* Header */}
              <div style={{ display: "flex", borderBottom: "1px solid #f0f0f0", background: "#fafafa", position: "sticky", top: 0, zIndex: 10 }}>
                <div style={{ width: colWidth, flexShrink: 0, height: 36, borderRight: "1px solid #f0f0f0", display: "flex", alignItems: "center", padding: "0 16px", position: "relative" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", fontFamily: font, textTransform: "uppercase", letterSpacing: ".5px" }}>Projeto / Tarefa</span>
                  <div onMouseDown={handleResizeStart} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", background: resizing ? "#3b82f6" : "transparent", transition: "background .15s" }}
                    onMouseEnter={e => { if (!resizing) e.currentTarget.style.background = "#d1d5db"; }}
                    onMouseLeave={e => { if (!resizing) e.currentTarget.style.background = "transparent"; }} />
                </div>
                <div style={{ flex: 1, position: "relative", height: 36 }}>
                  {months.map((m, i) => (
                    <div key={i} style={{ position: "absolute", left: `${getPct(m)}%`, top: 0, bottom: 0, display: "flex", alignItems: "center", paddingLeft: 6, borderLeft: i > 0 ? "1px solid #f0f0f0" : "none" }}>
                      <span style={{ fontSize: 11, color: "#9ca3af", fontFamily: font, fontWeight: 600, whiteSpace: "nowrap" }}>{m.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" })}</span>
                    </div>
                  ))}
                  <div style={{ position: "absolute", left: `${todayPct}%`, top: 0, bottom: 0, width: 2, background: "#ef4444", transform: "translateX(-50%)" }} />
                </div>
              </div>

              {projectsData.map((p, idx) => {
                const overdue = p.schedule.endDate < today && p.status !== "done";
                const barColor = overdue ? "#ef4444" : STATUS_COLORS[p.status] || "#9ca3af";
                const startPct = getPct(p.startDate);
                const endPct = getPct(p.schedule.endDate);
                const widthPct = Math.max(endPct - startPct, 0.5);
                const total = p.tasks.length, doneCnt = p.tasks.filter(t => t.done).length;
                const pct = total === 0 ? 0 : Math.round((doneCnt / total) * 100);
                return (
                  <div key={p.id}>
                    {/* Project row */}
                    <div style={{ display: "flex", borderBottom: "1px solid #f0f0f0", background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                      <div style={{ width: colWidth, flexShrink: 0, height: 52, display: "flex", alignItems: "center", padding: "0 16px", borderRight: "1px solid #f0f0f0", overflow: "hidden" }}>
                        <div style={{ overflow: "hidden" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a", fontFamily: font, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: font, marginTop: 1 }}>{pct}% · {STATUS_MAP[p.status]}</div>
                        </div>
                      </div>
                      <div style={{ flex: 1, position: "relative", height: 52 }}>
                        {months.map((m, i) => i > 0 && <div key={i} style={{ position: "absolute", left: `${getPct(m)}%`, top: 0, bottom: 0, width: 1, background: "#f0f0f0" }} />)}
                        <div style={{ position: "absolute", left: `${todayPct}%`, top: 0, bottom: 0, width: 2, background: "#ef444420", transform: "translateX(-50%)" }} />
                        <div style={{ position: "absolute", left: `${startPct}%`, width: `${widthPct}%`, top: "50%", transform: "translateY(-50%)", height: 26, borderRadius: 6, background: barColor + "20", border: `1.5px solid ${barColor}60`, overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: barColor + "50" }} />
                          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 6 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: barColor, fontFamily: font, whiteSpace: "nowrap" }}>{p.schedule.endDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* Task rows */}
                    {p.schedule.tasksWithDates.map(task => {
                      const tStartPct = getPct(task._start);
                      const tEndPct = getPct(task._end);
                      const tWidthPct = Math.max(tEndPct - tStartPct, 0.3);
                      const tColor = task.done ? "#22c55e" : "#6366f1";
                      const isDragging = dragState?.projectId === p.id && dragState?.taskId === String(task.id);
                      const anc = task.ancestorId ? p.schedule.tasksWithDates.find(t => String(t.id) === String(task.ancestorId)) : null;
                      const ancEndPct = anc ? getPct(anc._end) : null;
                      return (
                        <div key={task.id} style={{ display: "flex", borderBottom: "1px solid #f9f9f9", background: isDragging ? "#eef2ff" : idx % 2 === 0 ? "#fafffe" : "#f9fafc" }}>
                          <div style={{ width: colWidth, flexShrink: 0, height: 34, display: "flex", alignItems: "center", padding: "0 12px 0 28px", borderRight: "1px solid #f0f0f0", overflow: "hidden" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1, minWidth: 0 }}>
                              <div style={{ width: 5, height: 5, borderRadius: 2, background: tColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 11, color: task.done ? "#86efac" : "#6b7280", fontFamily: font, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0, textDecoration: task.done ? "line-through" : "none" }}>{task.text}</span>
                              {task.offsetWeeks !== 0 && <span style={{ fontSize: 9, color: "#a78bfa", fontFamily: font, flexShrink: 0 }}>{task.offsetWeeks > 0 ? "+" : ""}{task.offsetWeeks}s</span>}
                            </div>
                          </div>
                          <div style={{ flex: 1, position: "relative", height: 34 }} ref={el => { if (el) el._ganttContainer = el; }}>
                            {months.map((m, i) => i > 0 && <div key={i} style={{ position: "absolute", left: `${getPct(m)}%`, top: 0, bottom: 0, width: 1, background: "#f5f5f5" }} />)}
                            <div style={{ position: "absolute", left: `${todayPct}%`, top: 0, bottom: 0, width: 1, background: "#ef444415" }} />
                            {anc && ancEndPct !== null && tStartPct > ancEndPct && (
                              <div style={{ position: "absolute", left: `${ancEndPct}%`, width: `${tStartPct - ancEndPct}%`, top: "50%", height: 1, background: "#c7d2fe" }} />
                            )}
                            <div
                              onMouseDown={e => handleDragStart(e, p.id, String(task.id), e.currentTarget.parentElement)}
                              style={{ position: "absolute", left: `${tStartPct}%`, width: `${tWidthPct}%`, top: "50%", transform: "translateY(-50%)", height: 16, borderRadius: 4, background: isDragging ? tColor + "35" : tColor + "20", border: `1px solid ${isDragging ? tColor : tColor + "50"}`, display: "flex", alignItems: "center", paddingLeft: 4, overflow: "hidden", cursor: "grab", userSelect: "none", transition: isDragging ? "none" : "left 0.15s, background 0.15s" }}
                            >
                              <span style={{ fontSize: 9, fontWeight: 600, color: tColor, fontFamily: font, whiteSpace: "nowrap", pointerEvents: "none" }}>
                                {task.weeks ? `${task.weeks}s` : ""}{task.assignee ? ` ${task.assignee.split(" ")[0]}` : ""}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ padding: "10px 24px", borderTop: "1px solid #f0f0f0", display: "flex", gap: 16, alignItems: "center", flexShrink: 0, background: "#fafafa", flexWrap: "wrap" }}>
          {Object.entries(STATUS_COLORS).map(([k, color]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 11, color: "#6b7280", fontFamily: font }}>{STATUS_MAP[k]}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: "#ef4444" }} /><span style={{ fontSize: 11, color: "#6b7280", fontFamily: font }}>Atrasado</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}><div style={{ width: 2, height: 12, background: "#ef4444", borderRadius: 1 }} /><span style={{ fontSize: 11, color: "#6b7280", fontFamily: font }}>Hoje</span></div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ▸ TEAM MODAL
// ═══════════════════════════════════════════════════════════════
function TeamModal({ onClose, team, onUpdateTeam }) {
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingName, setEditingName] = useState(null); // { old, current }

  const addMember = async () => {
    const name = newName.trim();
    if (!name || team.some(m => m.name === name)) return;
    setSaving(true);
    try {
      const updated = [...team, { name }];
      await drive.saveTeam(updated);
      onUpdateTeam(updated);
      setNewName("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const removeMember = async (name) => {
    const updated = team.filter(m => m.name !== name);
    await drive.saveTeam(updated);
    onUpdateTeam(updated);
  };

  const confirmEdit = async () => {
    if (!editingName) return;
    const newVal = editingName.current.trim();
    if (!newVal || newVal === editingName.old) { setEditingName(null); return; }
    const updated = team.map(m => m.name === editingName.old ? { name: newVal } : m);
    await drive.saveTeam(updated);
    onUpdateTeam(updated);
    setEditingName(null);
  };

  const inputStyle = { width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: font, color: "#1a1a1a", outline: "none", background: "#fafafa", boxSizing: "border-box" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} className="auto-scroll" style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: 460, maxHeight: "78vh", overflow: "auto", boxShadow: "0 24px 48px rgba(0,0,0,.12)", padding: "28px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 700, color: "#1a1a1a", fontFamily: font }}>👥 Equipe</h2>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: "#9ca3af", fontFamily: font }}>Membros disponíveis para designação nas tarefas. Salvo em Drive › ProjectManager › Team.</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && addMember()} placeholder="Nome do membro..." style={{ ...inputStyle, flex: 1 }} />
          <button onClick={addMember} disabled={saving} style={{ padding: "10px 16px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font, opacity: saving ? .5 : 1 }}>+</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {team.map(m => (
            <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: editingName?.old === m.name ? "#f5f3ff" : "#fafafa", borderRadius: 10, border: editingName?.old === m.name ? "1px solid #e0e7ff" : "1px solid transparent" }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "#e0e7ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#4f46e5", flexShrink: 0, fontFamily: font }}>{m.name.charAt(0).toUpperCase()}</div>
              {editingName?.old === m.name
                ? <input autoFocus value={editingName.current} onChange={e => setEditingName(d => ({ ...d, current: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") confirmEdit(); if (e.key === "Escape") setEditingName(null); }} style={{ flex: 1, fontSize: 14, fontFamily: font, border: "none", outline: "1px solid #6366f1", borderRadius: 6, padding: "3px 8px", background: "#fff" }} />
                : <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "#1a1a1a", fontFamily: font }}>{m.name}</span>
              }
              {editingName?.old === m.name ? (
                <button onClick={confirmEdit} style={{ background: "#1a1a1a", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, fontFamily: font }}>OK</button>
              ) : (
                <button onClick={() => setEditingName({ old: m.name, current: m.name })} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 13, padding: "2px 6px" }} title="Editar nome"
                  onMouseEnter={e => e.currentTarget.style.color = "#6366f1"} onMouseLeave={e => e.currentTarget.style.color = "#9ca3af"}>✏️</button>
              )}
              <button onClick={() => removeMember(m.name)} style={{ background: "none", border: "none", color: "#d1d5db", cursor: "pointer", fontSize: 18, padding: "0 2px" }} onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#d1d5db"}>×</button>
            </div>
          ))}
          {team.length === 0 && <p style={{ color: "#c0c4cc", fontSize: 13, textAlign: "center", padding: 16, fontFamily: font }}>Nenhum membro adicionado</p>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24, paddingTop: 16, borderTop: "1px solid #f0f0f0" }}>
          <button onClick={onClose} style={{ padding: "10px 22px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ▸ ROLES MODAL
// ═══════════════════════════════════════════════════════════════
function RolesModal({ onClose, roles, onUpdateRoles, currentUser }) {
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("viewer");
  const [saving, setSaving] = useState(false);

  const addUser = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    setSaving(true);
    try {
      const updated = { ...roles, [email]: newRole };
      await drive.saveRoles(updated);
      await drive.shareFolder(email, newRole === "viewer" ? "reader" : "writer");
      onUpdateRoles(updated);
      setNewEmail("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const removeUser = async (email) => {
    const updated = { ...roles }; delete updated[email];
    await drive.saveRoles(updated); onUpdateRoles(updated);
  };

  const changeRole = async (email, role) => {
    const updated = { ...roles, [email]: role };
    await drive.saveRoles(updated); onUpdateRoles(updated);
  };

  const inputStyle = { width: "100%", padding: "10px 12px", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: font, color: "#1a1a1a", outline: "none", background: "#fafafa", boxSizing: "border-box" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} className="auto-scroll" style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: 480, maxHeight: "80vh", overflow: "auto", boxShadow: "0 24px 48px rgba(0,0,0,.12)", padding: "28px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 700, color: "#1a1a1a", fontFamily: font }}>🔑 Controle de Acessos</h2>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: "#9ca3af", fontFamily: font }}>Gerencie permissões de acesso ao Drive. A pasta será compartilhada automaticamente.</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && addUser()} placeholder="email@exemplo.com" style={{ ...inputStyle, flex: 1 }} />
          <select value={newRole} onChange={e => setNewRole(e.target.value)} style={{ ...inputStyle, width: 130, cursor: "pointer" }}>
            {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button onClick={addUser} disabled={saving} style={{ padding: "10px 16px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font, opacity: saving ? .5 : 1 }}>+</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#faf5ff", borderRadius: 10, border: "1px solid #ede9fe" }}>
            <span style={{ fontSize: 16 }}>👑</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a", fontFamily: font }}>{currentUser?.email}</div>
              <div style={{ fontSize: 11, color: "#7c3aed", fontFamily: font }}>Administrador (você)</div>
            </div>
          </div>
          {Object.entries(roles).filter(([email]) => email !== currentUser?.email).map(([email, role]) => (
            <div key={email} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#fafafa", borderRadius: 10 }}>
              <span style={{ fontSize: 16 }}>{ROLES[role]?.icon || "👤"}</span>
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a1a", fontFamily: font }}>{email}</div></div>
              <select value={role} onChange={e => changeRole(email, e.target.value)} style={{ padding: "4px 8px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 12, fontFamily: font, cursor: "pointer", background: "#fff" }}>
                {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <button onClick={() => removeUser(email)} style={{ background: "none", border: "none", color: "#d1d5db", cursor: "pointer", fontSize: 18 }} onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#d1d5db"}>×</button>
            </div>
          ))}
          {Object.keys(roles).filter(e => e !== currentUser?.email).length === 0 && (
            <p style={{ color: "#c0c4cc", fontSize: 13, textAlign: "center", padding: 16, fontFamily: font }}>Nenhum membro adicionado</p>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24, paddingTop: 16, borderTop: "1px solid #f0f0f0" }}>
          <button onClick={onClose} style={{ padding: "10px 22px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ▸ LOGIN SCREEN
// ═══════════════════════════════════════════════════════════════
function LoginScreen({ onLogin, loading }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f7f8fa", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: font }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "#1a1a1a", margin: "0 0 8px" }}>Project Manager</h1>
        <p style={{ fontSize: 14, color: "#9ca3af", margin: "0 0 32px", lineHeight: 1.6 }}>Gerencie seus projetos com sincronização no Google Drive. Seus dados ficam salvos como arquivos .md.</p>
        <button onClick={onLogin} disabled={loading} style={{ padding: "14px 32px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: loading ? "wait" : "pointer", fontFamily: font, display: "inline-flex", alignItems: "center", gap: 10, opacity: loading ? .6 : 1 }}
          onMouseEnter={e => !loading && (e.currentTarget.style.background = "#333")} onMouseLeave={e => (e.currentTarget.style.background = "#1a1a1a")}>
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          {loading ? "Conectando..." : "Entrar com Google"}
        </button>
        <p style={{ fontSize: 11, color: "#c0c4cc", marginTop: 20 }}>Seus projetos são salvos na pasta "ProjectManager" do seu Drive</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ▸ APP PRINCIPAL
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [fileMap, setFileMap] = useState({});
  const [folderMap, setFolderMap] = useState({});
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [roles, setRoles] = useState({});
  const [team, setTeam] = useState([]);
  const [toast, setToast] = useState({ message: "", type: "" });
  const [restoring, setRestoring] = useState(true);
  const tokenClientRef = useRef(null);

  // Owner sempre admin; cadastrados usam seu papel; desconhecidos são viewer
  const myRole = user ? (user.email === CONFIG.OWNER_EMAIL ? "admin" : (roles[user.email] || "viewer")) : "viewer";
  const canEdit = myRole === "admin" || myRole === "editor";
  const canManageRoles = myRole === "admin";

  const showToast = (message, type = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast({ message: "", type: "" }), 3000);
  };

  // Persist/restore session helpers
  const saveSession = (token, expiresIn, userInfo) => {
    const expiresAt = Date.now() + (expiresIn || 3600) * 1000;
    sessionStorage.setItem("pm_token", token);
    sessionStorage.setItem("pm_token_expires", String(expiresAt));
    sessionStorage.setItem("pm_user", JSON.stringify(userInfo));
  };
  const clearSession = () => {
    sessionStorage.removeItem("pm_token");
    sessionStorage.removeItem("pm_token_expires");
    sessionStorage.removeItem("pm_user");
  };

  const handleAuthSuccess = async (token, expiresIn, isRestore = false) => {
    drive.setToken(token);
    try {
      const userInfo = await drive.getUserInfo();
      saveSession(token, expiresIn, userInfo);
      setUser(userInfo);
      await syncFromDrive();
    } catch (e) {
      if (isRestore) { clearSession(); } else { showToast("Erro na autenticação: " + e.message, "error"); }
    }
    setLoading(false);
  };

  const initGoogle = useCallback(() => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => {
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: async (response) => {
          if (response.access_token) {
            await handleAuthSuccess(response.access_token, response.expires_in);
          }
        },
      });

      // Try to restore saved session
      const savedToken = sessionStorage.getItem("pm_token");
      const expiresAt = Number(sessionStorage.getItem("pm_token_expires") || "0");
      const savedUser = sessionStorage.getItem("pm_user");
      if (savedToken && expiresAt > Date.now() && savedUser) {
        // Token still valid — restore silently
        setLoading(true);
        handleAuthSuccess(savedToken, Math.round((expiresAt - Date.now()) / 1000), true)
          .finally(() => setRestoring(false));
      } else if (savedUser && savedToken) {
        // Token expired — try silent re-auth with prompt:''
        clearSession();
        setLoading(true);
        tokenClientRef.current.requestAccessToken({ prompt: "" });
        // If silent fails, Google shows consent — user picks account once
        setRestoring(false);
      } else {
        setRestoring(false);
      }
    };
    document.body.appendChild(script);
  }, []);

  useEffect(() => { initGoogle(); }, [initGoogle]);
  const handleLogin = () => { setLoading(true); tokenClientRef.current?.requestAccessToken(); };

  const syncFromDrive = async () => {
    setSyncing(true);
    try {
      // 1) List files + load roles/team in parallel
      const [files, rolesData, teamData] = await Promise.all([
        drive.listMdFiles(),
        drive.loadRoles(),
        drive.loadTeam(),
      ]);
      setRoles(rolesData);
      setTeam(teamData);

      // 2) Read all project files in parallel
      const fileContents = await Promise.all(files.map(async file => {
        const content = await drive.readFile(file.id);
        return { file, content };
      }));

      // 3) Parse projects, then load images + docs folders in parallel
      const parsed = fileContents.map(({ file, content }) => {
        const project = mdToProject(content);
        return project ? { file, project } : null;
      }).filter(Boolean);

      const results = await Promise.all(parsed.map(async ({ file, project }) => {
        const [image, docsFolderId] = await Promise.all([
          project.imageFileId ? drive.readFileAsDataUrl(project.imageFileId).catch(() => null) : Promise.resolve(null),
          drive.getOrCreateDocumentsFolder(file.projectFolderId),
        ]);
        project.image = image;
        return { file, project, docsFolderId };
      }));

      const loaded = [], map = {}, folders = {};
      for (const { file, project, docsFolderId } of results) {
        loaded.push(project);
        map[project.id] = file.id;
        folders[project.id] = { fileId: file.id, projectFolderId: file.projectFolderId, docsFolderId, imageFileId: project.imageFileId || null };
      }
      setProjects(loaded);
      setFileMap(map);
      setFolderMap(folders);
      showToast(`${loaded.length} projeto(s) sincronizado(s)`, "success");
    } catch (e) { showToast("Erro ao sincronizar: " + e.message, "error"); }
    setSyncing(false);
  };

  const saveProjectToDrive = async (project) => {
    try {
      const existing = folderMap[project.id];
      const projectFolderId = existing?.projectFolderId || await drive.getOrCreateProjectFolder(project.name);
      const docsFolderId = existing?.docsFolderId || await drive.getOrCreateDocumentsFolder(projectFolderId);
      let imageFileId = existing?.imageFileId || project.imageFileId || null;
      if (project.image && project.image.startsWith("data:")) imageFileId = await drive.saveImage(project.image, imageFileId, projectFolderId);
      const projectToSave = { ...project, imageFileId, image: null };
      const md = projectToMd(projectToSave);
      const filename = `${project.name.replace(/[^a-zA-Z0-9À-ú ]/g, "").trim().replace(/ +/g, "_") || "projeto"}.md`;
      const result = await drive.saveFile(filename, md, existing?.fileId || null, projectFolderId);
      setFileMap(prev => ({ ...prev, [project.id]: result.id }));
      setFolderMap(prev => ({ ...prev, [project.id]: { fileId: result.id, projectFolderId, docsFolderId, imageFileId } }));
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, imageFileId, image: project.image } : p));
      return true;
    } catch (e) { showToast("Erro ao salvar no Drive: " + e.message, "error"); return false; }
  };

  const addProject = async () => {
    const p = { id: String(Date.now()), name: "Novo Projeto", image: null, description: "", priority: "medium", status: "backlog", startDate: "", tasks: [], createdAt: new Date().toISOString().split("T")[0], _isNew: true };
    setProjects(prev => [...prev, p]);
    setEditing(p);
  };

  const saveProject = useCallback(async (updated) => {
    if (updated.tasks.length > 0 && updated.tasks.every(t => t.done) && updated.status !== "done") updated.status = "done";
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    setEditing(null);
    setSyncing(true);
    await saveProjectToDrive(updated);
    setSyncing(false);
    showToast("Projeto salvo no Drive", "success");
  }, [fileMap, folderMap]);

  const saveProjectSilent = useCallback(async (updated) => {
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    await saveProjectToDrive(updated);
  }, [fileMap, folderMap]);

  const deleteProject = useCallback(async (id) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    const folder = folderMap[id];
    if (folder?.projectFolderId) {
      try { await drive.deleteFile(folder.projectFolderId); } catch {}
      setFolderMap(prev => { const n = { ...prev }; delete n[id]; return n; });
      setFileMap(prev => { const n = { ...prev }; delete n[id]; return n; });
    } else if (fileMap[id]) {
      try { await drive.deleteFile(fileMap[id]); } catch {}
      setFileMap(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
    showToast("Projeto removido", "success");
  }, [fileMap, folderMap]);

  const filtered = (filter === "all" ? projects : projects.filter(p => p.status === filter))
    .slice().sort((a, b) => {
      const pctA = a.tasks.length === 0 ? 0 : a.tasks.filter(t => t.done).length / a.tasks.length;
      const pctB = b.tasks.length === 0 ? 0 : b.tasks.filter(t => t.done).length / b.tasks.length;
      return pctB - pctA;
    });
  const stats = {
    total: filtered.length,
    active: filtered.filter(p => p.status === "active" || p.status === "review").length,
    done: filtered.filter(p => p.status === "done").length,
    overdue: filtered.filter(p => { const s = calcProjectSchedule(p); return s.endDate && s.endDate < new Date() && p.status !== "done"; }).length,
  };
  const filteredTasks = filtered.flatMap(p => p.tasks);
  const costTotal = filteredTasks.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const costPaid = filteredTasks.filter(t => t.done).reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const costPending = costTotal - costPaid;

  if (!user && restoring) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: font, color: "#9ca3af", fontSize: 15 }}>
      Carregando...
    </div>
  );
  if (!user) return <LoginScreen onLogin={handleLogin} loading={loading} />;

  return (
    <div style={{ minHeight: "100vh", background: "#f7f8fa", fontFamily: font }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes slideIn{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .auto-scroll{scrollbar-width:thin;scrollbar-color:transparent transparent;transition:scrollbar-color .3s}
        .auto-scroll:hover{scrollbar-color:rgba(0,0,0,.18) transparent}
        .auto-scroll::-webkit-scrollbar{width:4px;height:4px}
        .auto-scroll::-webkit-scrollbar-track{background:transparent}
        .auto-scroll::-webkit-scrollbar-thumb{background:transparent;border-radius:4px;transition:background .3s}
        .auto-scroll:hover::-webkit-scrollbar-thumb{background:rgba(0,0,0,.18)}
        .auto-scroll::-webkit-scrollbar-thumb:active{background:rgba(0,0,0,.32)}
      `}</style>

      <header style={{ background: "#fff", borderBottom: "1px solid #eee", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#1a1a1a", letterSpacing: "-.3px" }}>Projetos</h1>
            {syncing && <div style={{ width: 16, height: 16, border: "2px solid #e5e7eb", borderTopColor: "#3b82f6", borderRadius: "50%", animation: "spin .6s linear infinite" }} />}
          </div>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#9ca3af" }}>
            {stats.total} projeto(s) · {stats.active} ativo(s) · {stats.done} concluído(s)
            {stats.overdue > 0 && <span style={{ color: "#ef4444", fontWeight: 600 }}> · {stats.overdue} atrasado(s)</span>}
          </p>
          {costTotal > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", fontFamily: font }}>Custos aproximados</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", background: "#eff6ff", padding: "2px 10px", borderRadius: 6, fontFamily: font }}>Total {costTotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#15803d", background: "#f0fdf4", padding: "2px 10px", borderRadius: 6, fontFamily: font }}>Pago {costPaid.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fff7ed", padding: "2px 10px", borderRadius: 6, fontFamily: font }}>A pagar {costPending.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: "#f3f4f6", borderRadius: 10, padding: 3 }}>
            {[["all", "Todos"], ["active", "Ativos"], ["review", "Revisão"], ["backlog", "Backlog"], ["done", "Concluídos"]].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 12px", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, background: filter === k ? "#fff" : "transparent", color: filter === k ? "#1a1a1a" : "#9ca3af", boxShadow: filter === k ? "0 1px 3px rgba(0,0,0,.06)" : "none", transition: "all .15s" }}>{l}</button>
            ))}
          </div>
          <button onClick={syncFromDrive} disabled={syncing} title="Sincronizar" style={{ padding: "8px 12px", background: "#f3f4f6", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 16 }}>🔄</button>
          <button onClick={() => setShowGantt(true)} style={{ padding: "8px 14px", background: "#f3f4f6", color: "#6b7280", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, display: "flex", alignItems: "center", gap: 6 }}>📊 Gantt</button>
          <button onClick={() => setShowTeam(true)} style={{ padding: "8px 14px", background: "#f3f4f6", color: "#6b7280", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, display: "flex", alignItems: "center", gap: 6 }}>👥 Equipe</button>
          {canManageRoles && <button onClick={() => setShowRoles(true)} style={{ padding: "8px 14px", background: "#f3f4f6", color: "#6b7280", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: font, display: "flex", alignItems: "center", gap: 6 }}>🔑 Acessos</button>}
          {canEdit && <button onClick={addProject} style={{ padding: "10px 20px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: font, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 18, lineHeight: 1 }}>+</span> Novo Projeto</button>}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 4px 4px", background: "#f3f4f6", borderRadius: 10 }}>
            {user.picture ? <img src={user.picture} alt="" style={{ width: 28, height: 28, borderRadius: 8 }} referrerPolicy="no-referrer" /> : <div style={{ width: 28, height: 28, borderRadius: 8, background: "#ddd", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>👤</div>}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a", fontFamily: font, lineHeight: 1.2 }}>{user.name}</div>
              <div style={{ fontSize: 10, color: ROLES[myRole]?.color || "#6b7280", fontWeight: 600, fontFamily: font }}>{ROLES[myRole]?.label}</div>
            </div>
          </div>
        </div>
      </header>

      <main style={{ padding: "28px 32px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
            <p style={{ fontSize: 16, color: "#9ca3af", marginBottom: 24, fontFamily: font }}>{projects.length === 0 ? "Nenhum projeto ainda" : "Nenhum projeto neste filtro"}</p>
            {projects.length === 0 && canEdit && <button onClick={addProject} style={{ padding: "12px 28px", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: font }}>Criar primeiro projeto</button>}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 20 }}>
            {filtered.map(p => <ProjectCard key={p.id} project={p} onClick={() => setEditing(p)} onDelete={deleteProject} canDelete={myRole === "admin"} />)}
          </div>
        )}
      </main>

      {editing && (
        <ProjectModal
          project={editing}
          onClose={() => setEditing(null)}
          onSave={saveProject}
          onCancelNew={() => { setProjects(prev => prev.filter(p => p.id !== editing.id)); setEditing(null); }}
          canEdit={canEdit}
          isNew={!!editing._isNew}
          docsUrl={folderMap[editing.id]?.docsFolderId ? `https://drive.google.com/drive/folders/${folderMap[editing.id].docsFolderId}` : null}
          team={team}
        />
      )}
      {showTeam && <TeamModal onClose={() => setShowTeam(false)} team={team} onUpdateTeam={setTeam} />}
      {showRoles && <RolesModal onClose={() => setShowRoles(false)} roles={roles} onUpdateRoles={setRoles} currentUser={user} />}
      {showGantt && <GanttChart projects={projects} onClose={() => setShowGantt(false)} onUpdateProject={saveProjectSilent} />}
      <Toast message={toast.message} type={toast.type} />
    </div>
  );
}
