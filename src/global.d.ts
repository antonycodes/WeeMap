interface Window {
  google?: {
    maps: {
      Map: new (element: HTMLElement, options: { center: { lat: number; lng: number }; zoom: number; disableDefaultUI: boolean }) => unknown;
    };
  };
}

interface Navigator {
  standalone?: boolean;
}
