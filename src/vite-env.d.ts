/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 客服微信号（一期人工充值公告展示用，为空时公告不显示微信号） */
  readonly VITE_SUPPORT_WECHAT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
