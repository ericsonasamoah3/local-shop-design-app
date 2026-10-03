import { useEffect, useRef, useState } from 'react';
import UploadForm from './components/UploadForm.jsx';
import IntakeForm from './components/IntakeForm.jsx';
import SuggestionList from './components/SuggestionList.jsx';
import MaskCanvas from './components/MaskCanvas.jsx';
import CompositePreview from './components/CompositePreview.jsx';
import CompositeTimeline from './components/CompositeTimeline.jsx';
import LocationPicker from './components/LocationPicker.jsx';
import ShopMap from './components/ShopMap.jsx';
import {
  getSuggestions,
  getShops,
  createComposite,
  pollComposite,
  requestCoverage,
  getCoverage,
} from './api/client';

const ORIGINAL = 'original';

// Gathering shops for a new area takes a few minutes; check every 8s for up
// to 15 minutes before giving up on waiting (the job itself carries on).
const COVERAGE_POLL_MS = 8000;
const COVERAGE_MAX_POLLS = 110;

export default function App() {
  const [upload, setUpload] = useState(null); // { upload_id, image_url }
  const [suggestState, setSuggestState] = useState({ status: 'idle', suggestions: [], message: null, error: null });
  const [pendingProduct, setPendingProduct] = useState(null); // product awaiting a mask

  // { lat, lon, label } or null. Kept for this visit only — never stored.
  const [location, setLocation] = useState(null);
  // The map's data. Loaded alongside suggestions; a failure here only costs
  // the map, never the suggestions.
  const [shopsState, setShopsState] = useState({ status: 'idle', shops: [] });
  // Whether we know shops near the user — see services/areaCatalog.js.
  const [coverage, setCoverage] = useState(null);

  // The last intake answers, so picks can refresh by themselves once shops
  // near the user have been gathered. Refs because the polling below
  // outlives the render that started it.
  const lastIntakeRef = useRef(null);
  const submitRef = useRef(null);

  useEffect(() => {
    if (!location) {
      setCoverage(null);
      return undefined;
    }

    let cancelled = false;
    let timer = null;
    let polls = 0;

    async function check(first) {
      let result;
      try {
        result = first ? await requestCoverage(location) : await getCoverage(location);
      } catch {
        // A refused start (e.g. rate limited) still deserves a status read.
        if (first) {
          try {
            result = await getCoverage(location);
          } catch {
            result = null;
          }
        }
      }
      if (cancelled) return;
      if (!result) {
        setCoverage({ status: 'error' });
        return;
      }

      setCoverage(result);

      if (result.status === 'gathering') {
        polls += 1;
        if (polls >= COVERAGE_MAX_POLLS) {
          setCoverage({ ...result, status: 'slow' });
          return;
        }
        timer = setTimeout(() => check(false), COVERAGE_POLL_MS);
      } else if (lastIntakeRef.current) {
        // Picks are already on screen: refresh them for this location —
        // either it was just set, or gathering just finished and there are
        // new shops to choose from.
        submitRef.current(lastIntakeRef.current);
      }
    }

    check(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [location]);

  // Every version of the room, oldest first. layers[0] is always the upload.
  // Compositing appends, so the user builds a scene up one item at a time
  // rather than starting over from the bare photo on every attempt.
  const [layers, setLayers] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(ORIGINAL);
  const [composite, setComposite] = useState({ status: null, error: null, notes: null });

  const activeLayer = layers.find((l) => l.id === activeLayerId) || layers[0];

  function handleUploaded(result) {
    setUpload(result);
    setLayers([{ id: ORIGINAL, url: result.image_url, label: 'Your photo', notes: null }]);
    setActiveLayerId(ORIGINAL);
  }

  async function handleIntakeSubmit(intake) {
    const { spaceType, budget, style } = intake;
    lastIntakeRef.current = intake;
    setSuggestState({ status: 'loading', suggestions: [], message: null, error: null });
    setPendingProduct(null);
    setShopsState((prev) => ({ ...prev, status: 'loading' }));

    getShops(location)
      .then((data) => setShopsState({ status: 'idle', shops: data.shops || [] }))
      .catch(() => setShopsState({ status: 'error', shops: [] }));

    try {
      const result = await getSuggestions({ uploadId: upload.upload_id, spaceType, budget, style, location });
      setSuggestState({
        status: 'idle',
        suggestions: result.suggestions || [],
        message: result.message || null,
        error: null,
      });
    } catch (err) {
      setSuggestState({ status: 'error', suggestions: [], message: null, error: err.message });
    }
  }

  submitRef.current = handleIntakeSubmit;

  // Step 1: picking a suggestion opens the mask step. No API call yet.
  function handleSelectSuggestion(product) {
    setComposite({ status: null, error: null, notes: null });
    setPendingProduct(product);
  }

  // Step 2: the mask is drawn, so start the job — layered onto whichever
  // version of the room is currently selected.
  async function handleMaskReady(maskDataUri) {
    const product = pendingProduct;
    setPendingProduct(null);
    setComposite({ status: 'processing', error: null, notes: null, label: product.name });

    try {
      const { composite_id: compositeId } = await createComposite({
        uploadId: upload.upload_id,
        productId: product.product_id,
        maskDataUri,
        baseCompositeId: activeLayerId === ORIGINAL ? null : activeLayerId,
      });
      const result = await pollComposite(compositeId);

      if (result.status === 'complete') {
        const layer = {
          id: result.composite_id,
          url: result.composite_url,
          label: product.name,
          notes: result.notes || null,
        };
        // Branching off an older frame discards the versions that came after
        // it, so the timeline stays a single readable history.
        setLayers((prev) => {
          const from = prev.findIndex((l) => l.id === activeLayerId);
          return [...prev.slice(0, from + 1), layer];
        });
        setActiveLayerId(layer.id);
        setComposite({ status: 'complete', error: null, notes: layer.notes });
      } else {
        setComposite({ status: 'failed', error: result.error, notes: result.notes || null });
      }
    } catch (err) {
      setComposite({ status: 'failed', error: err.message, notes: null });
    }
  }

  function handleSelectLayer(layerId) {
    setActiveLayerId(layerId);
    setPendingProduct(null);
    setComposite({ status: null, error: null, notes: null });
  }

  const hasSuggestions = suggestState.status === 'idle' && (suggestState.suggestions.length > 0 || suggestState.message);
  const featuredShopIds = new Set(suggestState.suggestions.map((s) => s.shop_id).filter(Boolean));

  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header__inner">
          <p className="wordmark">fill<span>stock</span></p>
          <p className="tagline">— sourced from shops near you</p>
        </div>
      </header>

      <section className="hero">
        <div className="hero__inner">
          <div className="reveal">
            <p className="hero__eyebrow">Phase 3 · bedding</p>
            <h1>
              Empty space.<br />
              Full cart. <em>All local.</em>
            </h1>
            <p>
              Upload a photo of any bare corner — a bed, a counter, a table —
              and we'll pull real pieces from shops near you to fill it in.
            </p>
            <ul className="steps">
              <li style={{ '--i': 0 }}><span className="num">01</span> Drop a photo of the space</li>
              <li style={{ '--i': 1 }}><span className="num">02</span> Tell us the budget and style</li>
              <li style={{ '--i': 2 }}><span className="num">03</span> Mark where it goes and preview</li>
            </ul>
          </div>
          <div className="hero__visual" aria-hidden="true">
            <div className="sample-tag">
              <p className="sample-tag__label">Duvet · mid</p>
              <p className="sample-tag__title">Linen Duvet</p>
              <p className="sample-tag__price">£89.99</p>
            </div>
          </div>
        </div>
      </section>

      <main>
        <section className="section reveal">
          <p className="section__eyebrow"><span className="num">1</span> Drop a photo</p>
          <h2>Show us the space</h2>

          {!upload && <UploadForm onUploaded={handleUploaded} />}

          {upload && (
            <div className="uploaded-preview">
              <img src={upload.image_url} alt="Your uploaded space" />
              <IntakeForm onSubmit={handleIntakeSubmit} submitting={suggestState.status === 'loading'}>
                <LocationPicker location={location} onChange={setLocation} coverage={coverage} />
              </IntakeForm>
            </div>
          )}
        </section>

        {suggestState.status === 'error' && (
          <section className="section reveal">
            <p role="alert">Couldn't load suggestions right now. Please try again.</p>
          </section>
        )}

        {hasSuggestions && (
          <section className="section reveal">
            <p className="section__eyebrow"><span className="num">2</span> Local picks</p>
            <h2>What we found nearby</h2>
            <SuggestionList
              suggestions={suggestState.suggestions}
              message={suggestState.message}
              coverage={coverage}
              onSelect={handleSelectSuggestion}
              selectingProductId={pendingProduct ? pendingProduct.product_id : null}
            />
          </section>
        )}

        {hasSuggestions && (
          <section className="section reveal">
            <p className="section__eyebrow"><span className="num">⌖</span> On the map</p>
            <h2>Where these shops are</h2>
            {shopsState.status === 'error' && (
              <p className="empty-note">Couldn't load the shop map right now. Your picks above are unaffected.</p>
            )}
            {shopsState.status !== 'error' && shopsState.shops.length === 0 && shopsState.status === 'idle' && (
              <p className="empty-note">No shop locations to show yet.</p>
            )}
            {shopsState.shops.length > 0 && (
              <>
                <p className="section__hint">
                  {location
                    ? 'Big ochre pins supplied your picks. Tap a pin for the address and distance.'
                    : 'Big ochre pins supplied your picks. Add your location above to see how far each one is.'}
                </p>
                <ShopMap shops={shopsState.shops} userLocation={location} featuredShopIds={featuredShopIds} />
              </>
            )}
          </section>
        )}

        {layers.length > 1 && (
          <section className="section reveal">
            <p className="section__eyebrow"><span className="num">★</span> Your versions</p>
            <h2>Every step, side by side</h2>
            <p className="section__hint">
              Each frame is the room after one addition. Pick any of them to keep building from
              that point — you don't have to start over.
            </p>
            <CompositeTimeline
              layers={layers}
              activeLayerId={activeLayerId}
              pending={composite.status === 'processing' ? { label: composite.label } : null}
              onSelect={handleSelectLayer}
            />
          </section>
        )}

        {pendingProduct && activeLayer && (
          <section className="section reveal">
            <p className="section__eyebrow"><span className="num">3</span> Mark the spot</p>
            <h2>Where should the {pendingProduct.name.toLowerCase()} go?</h2>
            {activeLayerId !== ORIGINAL && (
              <p className="section__hint">Adding to your composited version, not the bare photo.</p>
            )}
            {/* Keyed on the image so the drawn box resets when the base changes. */}
            <MaskCanvas
              key={activeLayer.url}
              imageUrl={activeLayer.url}
              onMaskReady={handleMaskReady}
            />
          </section>
        )}

        {composite.status && (
          <section className="section reveal">
            <p className="section__eyebrow"><span className="num">4</span> Preview</p>
            <h2>Your space, filled in</h2>
            <CompositePreview
              status={composite.status}
              compositeUrl={composite.status === 'complete' && activeLayer ? activeLayer.url : null}
              error={composite.error}
              notes={composite.notes}
            />
            {composite.status === 'complete' && (
              <p className="section__hint">
                Happy with it? Pick another item above and it'll be added to this version.
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="site-footer__inner">
          fillstock — phase 3 · real compositing · shops on the map
        </div>
      </footer>
    </div>
  );
}
