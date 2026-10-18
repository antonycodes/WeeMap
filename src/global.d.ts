interface Window {
  google?: {
    accounts: { id: {
      initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void;
      renderButton: (element: HTMLElement, options: { theme: string; size: string; text: string; locale: string }) => void;
      disableAutoSelect: () => void;
    } };

    maps: {
      Map: new (element: HTMLElement, options: { center: { lat: number; lng: number }; zoom: number; disableDefaultUI: boolean }) => {
        setZoom: (zoom: number) => void;
        panTo: (center: { lat: number; lng: number }) => void;
      };
    };
  };
}

interface Navigator {
  standalone?: boolean;
}
