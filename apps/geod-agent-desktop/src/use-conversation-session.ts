import {useCallback,useSyncExternalStore,type Dispatch,type SetStateAction} from 'react';
import type {ConversationSession} from './conversation-sessions';

/** Callbacks retain their originating session even when another chat becomes visible. */
export function useConversationState<T>(session:ConversationSession,key:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>] {
  session.get(key,initial);
  const read=useCallback(()=>session.get<T>(key,initial),[session,key]);
  const value=useSyncExternalStore(session.subscribe,read,read);
  const set=useCallback((next:SetStateAction<T>)=>session.set(key,next),[session,key]);
  return [value,set];
}
