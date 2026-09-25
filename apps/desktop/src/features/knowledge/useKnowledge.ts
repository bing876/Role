/**
 * 资料（知识库）—— 从 `App.tsx` 抽出的**逻辑**，**行为逐字未改**。
 *
 * 这一片只动「逻辑」，不动 JSX、不动 CSS（用户 2026-09-24 的叫停）。
 * App 那边调用后按**同名的**解构取回这些值，所以 3714 行里的 JSX 一个字都不用改：
 *
 *   const {
 *     knowledgeDocs, knowledgeOpen, setKnowledgeOpen, knowledgeUploading,
 *     knowledgeNote, knowledgeDeletingId, knowledgeFileRef,
 *     setKnowledgeDocs, setKnowledgeOpen: …, loadKnowledge, uploadKnowledgeFile,
 *     onChooseKnowledgeFile, deleteKnowledgeDoc,
 *   } = useKnowledge({ sessionRef, curProjectRef });
 *
 * ⚠️ 抽出去之后**不许删掉 7 个"最新值镜像" ref 里的任何一个**（这一片没碰它们）：
 *   Provider/Hook 里的 `useState` 同样是闭包语义，镜像 ref 一旦删掉，
 *   「事件处理器读到上一轮的值」那类 bug 会立刻回来。
 *
 * 依赖注入（而不是 import App）：`sessionRef` / `curProjectRef` 由调用方给，
 *   hook 自己不持有会话与项目的真相 —— 这样 `features/**` 不反向依赖 `app/**`。
 */
import { useRef, useState } from 'react';
import type { ChangeEvent, MutableRefObject } from 'react';
import type {
  AuthSession,
  KnowledgeDeleteResult,
  KnowledgeDocument,
  KnowledgeListResult,
  KnowledgeUploadResult,
} from '@ai-workbench/shared';
import { API_BASE, authFetchJson, dbHint } from '../../shared/api';

export interface UseKnowledgeOptions {
  /** 会话镜像（App 侧的 `sessionRef`）。hook 每次用时现读，避免拿到旧 token。 */
  sessionRef: MutableRefObject<AuthSession | null>;
  /** 当前项目镜像（App 侧的 `curProjectRef`）。资料按项目隔离，切项目后要按新的拉。 */
  curProjectRef: MutableRefObject<number | null>;
}

export interface KnowledgeApi {
  documents: KnowledgeDocument[];
  setDocuments: (next: KnowledgeDocument[] | ((prev: KnowledgeDocument[]) => KnowledgeDocument[])) => void;
  open: boolean;
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  uploading: boolean;
  note: string;
  deletingId: number | null;
  fileRef: MutableRefObject<HTMLInputElement | null>;
  /** 拉列表：不传 projectId 就走「服务端当前使用中的项目」 */
  load: (projectId?: number | null) => Promise<void>;
  upload: (file: File) => Promise<void>;
  onChooseFile: (event: ChangeEvent<HTMLInputElement>) => void;
  remove: (doc: KnowledgeDocument) => Promise<void>;
  /** 登出时把这套状态清干净（原先散在 App 的 onLogout 里 5 行，收成一句） */
  reset: () => void;
}

export function useKnowledge({ sessionRef, curProjectRef }: UseKnowledgeOptions): KnowledgeApi {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ---- 第 11 步：资料上传/列表。文件直接由当前渲染进程 POST 到本机服务端，
  // 不经过 preload，不开新窗口；multipart 的 Content-Type 必须让浏览器自己带 boundary。 ----
  /**
   * 子阶段 2-B：资料列表**按项目**拉（`?projectId=`）。
   * 不传就走服务端的「当前使用中的项目」——两条路都以服务端为准，前端不自己过滤。
   */
  const load = async (projectId?: number | null) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const pid = projectId === undefined ? curProjectRef.current : projectId;
    try {
      const r = await authFetchJson<KnowledgeListResult>(pid === null ? '/knowledge' : `/knowledge?projectId=${pid}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // 切号期间晚到的 A 号响应不能覆盖 B 号列表。
      if (sessionRef.current?.token !== sess.token) return;
      setDocuments(r.documents);
    } catch {
      /* 资料列表属于辅助入口，后端暂不可达时不打扰已登录界面 */
    }
  };

  const upload = async (file: File) => {
    const sess = sessionRef.current;
    if (!sess || uploading) return;
    const supported = /\.(txt|md|pdf)$/i.test(file.name);
    if (!supported) {
      setNote('只支持 .txt、.md、.pdf 文件。');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setNote('文件超过 12 MB，本版请拆分后上传。');
      return;
    }
    setNote('');
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      let res: Response;
      try {
        res = await fetch(`${API_BASE()}/knowledge/upload`, {
          method: 'POST',
          headers: { authorization: `Bearer ${sess.token}` },
          body: form,
        });
      } catch {
        throw new Error(`连不上后端 ${API_BASE()}：先双击仓库根目录的 start-dev.cmd 起库和服务端，再重试`);
      }
      const data = (await res.json().catch(() => ({}))) as KnowledgeUploadResult & { error?: string };
      if (!res.ok) throw new Error(dbHint(data.error) ?? `HTTP ${res.status}`);
      // 若用户在上传过程中退出/切换账号，不把旧账号的成功提示带到新账号界面。
      if (sessionRef.current?.token !== sess.token) return;
      const doc = data.document;
      setNote(`《${doc.filename}》已入库，共 ${doc.chunkCount} 个片段。`);
      await load(curProjectRef.current);
    } catch (e) {
      setNote(`上传没有入库：${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const onChooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // 清空值后，用户选择同一份文件也会再次触发 change。
    event.currentTarget.value = '';
    if (file) void upload(file);
  };

  /**
   * 第 19 步：删掉当前账号的一条资料（服务端连它的切块一起删）。
   *
   * 一点就删、只回一句人话 —— 不做二次确认弹窗，也不做回收站/重命名（本步明确不做）。
   * 删除权限完全由服务端的 JWT 决定：这里只传资料 id，删不到别人的资料（会得到 404）。
   * 本地列表用「过滤掉这条」而不是整表重拉，避免删完闪烁；刷新页面时以服务端为准。
   */
  const remove = async (doc: KnowledgeDocument) => {
    const sess = sessionRef.current;
    if (!sess || deletingId !== null) return;
    setNote('');
    setDeletingId(doc.id);
    try {
      const r = await authFetchJson<KnowledgeDeleteResult>(`/knowledge/${doc.id}`, {
        method: 'DELETE',
        // 空 body 会被 fastify 判 400，这里明确送一个 JSON 空对象。
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // 删除期间切了账号：不要拿 A 号的结果去动 B 号的列表/提示。
      if (sessionRef.current?.token !== sess.token) return;
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      setNote(`《${doc.filename}》已删除${r.removedChunks ? `（连同 ${r.removedChunks} 个片段）` : ''}。`);
    } catch (e) {
      if (sessionRef.current?.token !== sess.token) return;
      setNote(`删除失败：${(e as Error).message}`);
      void load(curProjectRef.current); // 服务端说没有这份资料时，用真实列表把界面拉回来
    } finally {
      setDeletingId(null);
    }
  };

  /** 登出：列表、面板、上传中、删除中、提示 —— 一次清干净（与原先 5 行等价、顺序一致） */
  const reset = () => {
    setDocuments([]);
    setOpen(false);
    setUploading(false);
    setDeletingId(null);
    setNote('');
  };

  return {
    documents,
    setDocuments,
    open,
    setOpen,
    uploading,
    note,
    deletingId,
    fileRef,
    load,
    upload,
    onChooseFile,
    remove,
    reset,
  };
}
