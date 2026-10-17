interface Window {
  google?: {
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