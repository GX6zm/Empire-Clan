/**
 * main.js —— 入口
 */

import { App } from './ui/app.js';

const $ = (id) => document.getElementById(id);

const app = new App({
  boot: $('boot'),
  bootMsg: $('boot-msg'),
  bootDetail: $('boot-detail'),
  app: $('app'),

  hud: $('hud'),
  toolbar: $('toolbar'),
  nav: $('navbar'),

  viewFocus: $('view-focus'),
  viewDossier: $('view-dossier'),
  dossier: $('dossier'),

  map: $('map'),
  viewport: $('viewport'),
  tree: $('tree'),
  zoomLabel: $('zoom-label'),
  canvasTools: $('canvas-tools'),

  situation: $('situation'),
  situationBody: $('situation-body'),
  sitToggle: $('sit-toggle'),
  sitExpand: $('sit-expand'),

  detail: $('detail'),
  log: $('log'),
  modalRoot: $('modal-root'),
});

// 方便在浏览器控制台里调戏
window.__FOCUS__ = app;

app.boot();
