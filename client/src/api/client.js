import axios from 'axios';
import { API_BASE_URL } from '../config';

const STORAGE_KEY = 'zlp_viewmode';

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (localStorage.getItem(STORAGE_KEY) === 'demoStudent') {
    config.headers['X-Student-Context'] = 'demo';
  }
  return config;
});

export default api;
