import { convertFileSrc, invoke } from '@tauri-apps/api/core';
export interface IonTerrainSession { sessionId: string; resourcePath: string; connectionId: string; assetId: number }
export interface IonTerrainStatus { connectionId: string; assetId: number; requests: number; loaded: number; lastHttpStatus: number }
export const ionTerrain = {
  async open(conversationId: string, connectionId: string | undefined, assetId: number) {
    if (!connectionId) {
      const connections = await invoke<{id:string;name:string;kind:string;credentialReady:boolean}[]>('tiles3d_connections_list');
      const ready = connections.filter(c => c.kind === 'cesiumIon' && c.credentialReady);
      if (ready.length !== 1) throw new Error(ready.length ? '存在多个 Ion 连接，请使用实际 connectionId 选择。' : '请先在三维数据连接中保存 Ion 凭据。');
      connectionId = ready[0].id;
    }
    return invoke<IonTerrainSession>('ion_terrain_open', { conversationId, connectionId, assetId });
  },
  url(session: IonTerrainSession) { return `${convertFileSrc(session.sessionId, 'geod-terrain')}/root/`; },
  close(sessionId: string) { return invoke<void>('ion_terrain_close', { sessionId }); },
  status(sessionId: string) { return invoke<IonTerrainStatus>('ion_terrain_status', { sessionId }); },
};
