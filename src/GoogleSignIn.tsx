import { useEffect, useRef, useState } from 'react';

const clientId = '271810624076-8k55732jc0f0krn8p3uhcfnac6sv6lk2.apps.googleusercontent.com';
let library: Promise<void> | undefined;
let credentialHandler: ((token: string) => void) | undefined;

function loadSignIn() {
  return library ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      window.google?.accounts.id.initialize({ client_id: clientId, callback: ({ credential }) => credentialHandler?.(credential) });
      resolve();
    };
    script.onerror = () => { library = undefined; script.remove(); reject(new Error('Google unavailable')); };
    document.head.append(script);
  });
}

export default function GoogleSignIn({ onCredential }: { onCredential: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const callback = (token: string) => { if (active) handler.current(token); };
    credentialHandler = callback;
    void loadSignIn().then(() => {
      if (active && container.current) window.google?.accounts.id.renderButton(container.current, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'vi' });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (credentialHandler === callback) credentialHandler = undefined; };
  }, []);
  return <div className="trip-field"><span>Đăng nhập Google để quản lý chuyến</span><div ref={container} />{failed && <p className="trip-error" role="alert">Không tải được Google. Kiểm tra mạng và tải lại trang.</p>}</div>;
}
