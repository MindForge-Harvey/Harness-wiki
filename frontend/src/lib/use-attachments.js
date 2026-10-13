import { useCallback, useEffect, useRef, useState } from "react";
import { selectAttachments } from "./attachments.mjs";

export function useAttachments() {
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState("");
  const itemsRef = useRef([]);
  const readersRef = useRef(new Map());
  const commit = useCallback(items => { itemsRef.current = items; setAttachments(items); }, []);
  const read = useCallback(item => {
    const reader = new FileReader();
    readersRef.current.set(item.id, reader);
    const finish = patch => {
      readersRef.current.delete(item.id);
      commit(itemsRef.current.map(current => current.id === item.id ? { ...current, ...patch } : current));
    };
    reader.onload = () => {
      const src = String(reader.result || "");
      finish({ status: "ready", src, data: src.slice(src.indexOf(",") + 1) });
    };
    reader.onerror = () => finish({ status: "error", error: "读取失败，请重试" });
    reader.onabort = () => readersRef.current.delete(item.id);
    reader.readAsDataURL(item.file);
  }, [commit]);
  const add = useCallback(files => {
    const { accepted, errors } = selectAttachments(itemsRef.current, files);
    setError(errors.join("；"));
    const next = accepted.map(({ file, fingerprint }) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, mimeType: file.type, file, fingerprint, status: "reading" }));
    commit([...itemsRef.current, ...next]);
    next.forEach(read);
  }, [commit, read]);
  const remove = useCallback(id => {
    readersRef.current.get(id)?.abort();
    commit(itemsRef.current.filter(item => item.id !== id));
    setError("");
  }, [commit]);
  const retry = useCallback(id => {
    const item = itemsRef.current.find(item => item.id === id);
    if (!item) return;
    commit(itemsRef.current.map(current => current.id === id ? { ...current, status: "reading", error: "" } : current));
    read(item);
  }, [commit, read]);
  const clear = useCallback(() => {
    readersRef.current.forEach(reader => reader.abort());
    readersRef.current.clear();
    commit([]);
    setError("");
  }, [commit]);
  useEffect(() => () => {
    readersRef.current.forEach(reader => reader.abort());
    readersRef.current.clear();
  }, []);
  return { attachments, error, add, remove, retry, clear, reportError: setError, dismissError: () => setError(""), blocked: attachments.some(item => item.status !== "ready") };
}
