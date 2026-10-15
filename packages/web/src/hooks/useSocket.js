import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth/AuthProvider';

const API_URL = import.meta.env.VITE_API_URL || '';

// The API only accepts sockets that present the session JWT, and delivers
// events to the caller's org only (api/src/services/realtime.js). Event
// payloads carry no metric data — listeners refetch over the REST API.
export function useSocket() {
  const { token } = useAuth();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    socketRef.current = io(API_URL || window.location.origin, {
      transports: ['websocket', 'polling'],
      auth: { token },
    });

    socketRef.current.on('connect', () => setConnected(true));
    socketRef.current.on('disconnect', () => setConnected(false));

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const on = useCallback((event, callback) => {
    socketRef.current?.on(event, callback);
  }, []);

  const off = useCallback((event, callback) => {
    socketRef.current?.off(event, callback);
  }, []);

  return { socket: socketRef.current, connected, on, off };
}
