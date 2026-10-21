import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, DownloadSimple, FileDoc, FileHtml, FilePdf, FilePpt, FileText, FileXls, X } from "@phosphor-icons/react";
import { documentUrl, documentViewUrl } from "../lib/api";
import { Markdown } from "../lib/markdown";

/** 预览大小上限：超过则只提供下载，避免前端解析卡死页面。 */
const PREVIEW_LIMIT = 20 * 1024 * 1024;

export const previewIcon = kind => (kind === "Word" ? FileDoc : kind === "Excel" ? FileXls : kind === "PPT" ? FilePpt : kind === "PDF" ? FilePdf : kind === "HTML" ? FileHtml : FileText);

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** 拉取并解析文档：md/txt 直接读文本，docx/xlsx 前端转 HTML，pdf/html 用 iframe 打开。 */
export function useDocumentContent(sessionId, doc, enabled = true) {
  const [state, setState] = useState({ status: "idle", content: null, note: "" });
  const [nonce, setNonce] = useState(0);
  const blobUrlRef = useRef(null);

  useEffect(() => {
    if (!enabled || !doc) {
      setState({ status: "idle", content: null, note: "" });
      return undefined;
    }
    let alive = true;
    setState({ status: "loading", content: null, note: "" });
    const release = () => { if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; } };
    // HTML 演示文稿交给 iframe 内联加载，附带资源按相对路径解析，不走 blob。
    if (doc.ext === "html" || doc.ext === "htm") {
      setState({ status: "ready", content: { kind: "web", url: documentViewUrl(sessionId, doc.path), nonce } });
      return undefined;
    }
    (async () => {
      try {
        const res = await fetch(documentUrl(sessionId, doc.path));
        if (!res.ok) throw new Error(`读取文档失败（HTTP ${res.status}）`);
        const blob = await res.blob();
        if (blob.size > PREVIEW_LIMIT) throw Object.assign(new Error("文件过大，请下载后查看"), { previewable: false });
        if (doc.ext === "pdf") {
          release();
          blobUrlRef.current = URL.createObjectURL(blob);
          if (alive) setState({ status: "ready", content: { kind: "pdf", url: blobUrlRef.current } });
          return;
        }
        const buffer = await blob.arrayBuffer();
        let view;
        if (doc.ext === "docx") {
          const mammoth = (await import("mammoth")).default;
          const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
          view = { kind: "html", html: value };
        } else if (doc.ext === "xlsx" || doc.ext === "xls" || doc.ext === "csv") {
          const XLSX = await import("xlsx");
          const book = XLSX.read(buffer, { type: "array" });
          const sheet = book.Sheets[book.SheetNames[0]];
          if (!sheet) throw new Error("表格为空");
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
          view = { kind: "sheet", rows, sheetName: book.SheetNames[0], total: book.SheetNames.length };
        } else {
          const text = new TextDecoder().decode(buffer);
          view = { kind: doc.ext === "md" ? "markdown" : "text", text: doc.ext === "json" ? prettyJson(text) : text };
        }
        if (alive) setState({ status: "ready", content: view });
      } catch (error) {
        if (alive) setState({ status: error.previewable ? "download-only" : "error", content: null, note: error.message });
      }
    })();
    return () => { alive = false; release(); };
  }, [sessionId, doc, enabled, nonce]);

  return { state, reload: () => setNonce(value => value + 1) };
}

/** 预览内容渲染：分栏和全屏浮层共用。 */
export function DocumentBody({ doc, state }) {
  if (state.status === "loading") return <p className="doc-preview-note">正在加载预览…</p>;
  if (state.status === "error") {
    return (
      <div className="doc-preview-note is-error">
        <p>{state.note}</p>
        <p>可使用下载按钮保存后本地查看。</p>
      </div>
    );
  }
  if (state.status !== "ready" || !state.content) return null;
  const { content } = state;
  if (content.kind === "web") {
    return (
      <iframe
        key={content.nonce}
        className="doc-preview-frame"
        src={content.url}
        title={`HTML 预览 ${doc.name}`}
        sandbox="allow-scripts allow-popups allow-forms"
      />
    );
  }
  if (content.kind === "pdf") return <iframe className="doc-preview-frame" src={content.url} title={`PDF 预览 ${doc.name}`} />;
  if (content.kind === "markdown") return <div className="chat-md doc-preview-md"><Markdown>{content.text}</Markdown></div>;
  if (content.kind === "text") return <pre className="doc-preview-text">{content.text}</pre>;
  if (content.kind === "html") return <div className="doc-preview-docx" dangerouslySetInnerHTML={{ __html: content.html }} />;
  if (content.kind === "sheet") {
    return (
      <div className="doc-preview-sheet">
        <p className="doc-preview-sheet-note">{`工作表「${content.sheetName}」${content.total > 1 ? `（共 ${content.total} 个，仅展示第一个）` : ""}`}</p>
        <table>
          <tbody>
            {content.rows.map((row, index) => (
              <tr key={index}>{row.map((cell, cellIndex) => (index === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

/** 全屏预览浮层：停靠分栏右上角的「全屏查看」入口。 */
export function DocumentPreview({ sessionId, doc, onClose }) {
  const { state, reload } = useDocumentContent(sessionId, doc, true);

  useEffect(() => {
    if (!doc) return undefined;
    const handleEscape = event => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [doc, onClose]);

  if (!doc) return null;
  const Icon = previewIcon(doc.kind);

  return (
    <div className="doc-preview-overlay" role="dialog" aria-modal="true" aria-label={`全屏预览 ${doc.name}`} onClick={onClose}>
      <section className="doc-preview" onClick={event => event.stopPropagation()}>
        <header className="doc-preview-heading">
          <span className="doc-preview-icon" aria-hidden="true"><Icon size={20} /></span>
          <div className="doc-preview-title">
            <strong title={doc.name}>{doc.name}</strong>
            <small>{doc.kind} · {doc.path}</small>
          </div>
          <a className="doc-preview-action" href={documentUrl(sessionId, doc.path)} download={doc.name} title={`下载 ${doc.name}`} aria-label={`下载 ${doc.name}`}>
            <DownloadSimple size={18} />
          </a>
          <button className="doc-preview-action" type="button" title="重新加载" aria-label="重新加载预览" onClick={reload}>
            <ArrowClockwise size={18} />
          </button>
          <button className="doc-preview-action" type="button" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="doc-preview-body" aria-live="polite">
          <DocumentBody doc={doc} state={state} />
          {(state.status === "download-only" || (state.status === "ready" && (doc.ext === "ppt" || doc.ext === "pptx"))) && (
            <div className="doc-preview-note">
              <p>{doc.ext === "ppt" || doc.ext === "pptx" ? "PPT 暂不支持在线预览" : state.note}</p>
              <p>请使用右上角按钮下载后查看。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
