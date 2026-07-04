import axios from 'axios';

const STORAGE_KEY = 'zlp_viewmode';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (localStorage.getItem(STORAGE_KEY) === 'demoStudent') {
    config.headers['X-Student-Context'] = 'demo';
  }
  return config;
});

export default api;
