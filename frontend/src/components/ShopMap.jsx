import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// The shops behind the suggestions, on a map, with the user if we know where
// they are. Shops that supplied one of the current suggestions are drawn
// larger and in ochre; the rest of the catalogue's shops are smaller.
//
// Plain Leaflet rather than react-leaflet: one map, imperatively updated, is
// less code than a wrapper and has no React-version coupling. Circle markers
// rather than Leaflet's default pin images, which break under bundlers.
//
// Tiles come from openstreetmap.org, whose policy requires the attribution
// below and is fine for low traffic. Move to a commercial tile provider if
// usage grows.

const COLORS = {
  ink: '#1f2b22',
  featured: '#c98a2e',
  other: '#6e7860',
  user: '#b14b32',
  paper: '#fbf8f0',
};

// Shop names and addresses come from scraped data, so popups are built from
// DOM nodes with textContent rather than an HTML string.
function popupFor(shop, featured) {
  const root = document.createElement('div');
  root.className = 'map-popup';

  const name = document.createElement('p');
  name.className = 'map-popup__name';
  name.textContent = shop.name;
  root.appendChild(name);

  if (shop.location) {
    const address = document.createElement('p');
    address.className = 'map-popup__meta';
    address.textContent = shop.location;
    root.appendChild(address);
  }

  const meta = document.createElement('p');
  meta.className = 'map-popup__meta';
  const parts = [];
  if (shop.distance_miles !== null && shop.distance_miles !== undefined) {
    parts.push(`${shop.distance_miles} mi away`);
  }
  parts.push(`${shop.product_count} item${shop.product_count === 1 ? '' : 's'} in stock here`);
  if (featured) parts.push('in your picks');
  meta.textContent = parts.join(' · ');
  root.appendChild(meta);

  if (shop.website && /^https?:\/\//i.test(shop.website)) {
    const link = document.createElement('a');
    link.href = shop.website;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Visit website';
    root.appendChild(link);
  }

  return root;
}

export default function ShopMap({ shops, userLocation, featuredShopIds }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  // Create the map once.
  useEffect(() => {
    const map = L.map(containerRef.current, {
      // Scroll-wheel zoom hijacks page scrolling; buttons and pinch still work.
      scrollWheelZoom: false,
    }).setView([54.5, -3], 5); // all of the UK, until markers arrive
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // Redraw markers whenever the data changes.
  const featuredKey = [...featuredShopIds].sort().join(',');
  useEffect(() => {
    const map = mapRef.current;
    const group = layerRef.current;
    if (!map || !group) return;

    group.clearLayers();
    const points = [];

    // Featured shops last, so they sit on top where pins overlap.
    const ordered = [...shops].sort(
      (a, b) => Number(featuredShopIds.has(a.shop_id)) - Number(featuredShopIds.has(b.shop_id))
    );
    for (const shop of ordered) {
      const featured = featuredShopIds.has(shop.shop_id);
      L.circleMarker([shop.lat, shop.lon], {
        radius: featured ? 11 : 7,
        color: COLORS.ink,
        weight: 2,
        fillColor: featured ? COLORS.featured : COLORS.other,
        fillOpacity: 0.95,
      })
        .bindPopup(popupFor(shop, featured))
        .bindTooltip(shop.name, { direction: 'top', offset: [0, -8] })
        .addTo(group);
      points.push([shop.lat, shop.lon]);
    }

    if (userLocation) {
      L.circleMarker([userLocation.lat, userLocation.lon], {
        radius: 9,
        color: COLORS.user,
        weight: 4,
        fillColor: COLORS.paper,
        fillOpacity: 1,
      })
        .bindTooltip('You', { permanent: true, direction: 'right', offset: [10, 0], className: 'map-you' })
        .addTo(group);
      points.push([userLocation.lat, userLocation.lon]);
    }

    if (points.length === 1) {
      map.setView(points[0], 13);
    } else if (points.length > 1) {
      map.fitBounds(points, { padding: [40, 40], maxZoom: 14 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops, userLocation, featuredKey]);

  return <div ref={containerRef} className="shop-map" role="region" aria-label="Map of shops" />;
}
