// Danh sách đợt đặt hàng — dùng chung giữa màn Chi tiết và màn Quản lý.
import { rpc } from './api.js';
import { state } from './state.js';

export async function loadSessions() {
  const result = await rpc('listSessions', {});
  state.sessions = Array.isArray(result) ? result : [];
  const matchMien = s => state.mien === 'ALL' ? true : s.mien === state.mien;
  const open = state.sessions.find(s => matchMien(s) && (s.trang_thai === 'DRAFT' || s.trang_thai === 'SUBMITTED'));
  state.currentSession = open || state.sessions.find(matchMien) || null;
}
