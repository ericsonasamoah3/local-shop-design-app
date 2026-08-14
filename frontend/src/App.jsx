import { useState } from 'react';
import UploadForm from './components/UploadForm.jsx';
import IntakeForm from './components/IntakeForm.jsx';
import SuggestionList from './components/SuggestionList.jsx';
import MaskCanvas from './components/MaskCanvas.jsx';
import CompositePreview from './components/CompositePreview.jsx';
import { getSuggestions, createComposite, pollComposite } from './api/client';

export default function App() {
  const [upload, setUpload] = useState(null); // { upload_id, image_url }
  const [suggestState, setSuggestState] = useState({ status: 'idle', suggestions: [], message: null, error: null });
  const [pendingProductId, setPendingProductId] = useState(null); // product awaiting mask
  const [compositeState, setCompositeState] = useState({ status: null, url: null, error: null });

  async function handleIntakeSubmit({ spaceType, budget, style }) {
    setSuggestState({ status: 'loading', suggestions: [], message: null, error: null });
    setCompositeState({ status: null, url: null, error: null });
    setPendingProductId(null);

    try {
      const result = await getSuggestions({ uploadId: upload.upload_id, spaceType, budget, style });
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

  // Step 1: user picks a suggestion — this just opens the mask-drawing step,
  // it doesn't call the API yet.
  function handleSelectSuggestion(productId) {
    setCompositeState({ status: null, url: null, error: null });
    setPendingProductId(productId);
  }

  // Step 2: user draws a mask — now we actually kick off the composite job
  // and poll until it's done.
  async function handleMaskReady(maskDataUri) {
    const productId = pendingProductId;
    setPendingProductId(null);
    setCompositeState({ status: 'processing', url: null, error: null });

    try {
      const { composite_id: compositeId } = await createComposite({
        uploadId: upload.upload_id,
        productId,
        maskDataUri,
      });
      const result = await pollComposite(compositeId);

      if (result.status === 'complete') {
        setCompositeState({ status: 'complete', url: result.composite_url, error: null });
      } else {
        setCompositeState({ status: 'failed', url: null, error: result.error });
      }
    } catch (err) {
      setCompositeState({ status: 'failed', url: null, error: err.message });
    }
  }

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
          <div>
            <p className="hero__eyebrow">Phase 2 · bedding</p>
            <h1>
              Empty space.<br />
              Full cart. <em>All local.</em>
            </h1>
            <p>
              Upload a photo of any bare corner — a bed, a counter, a table —
              and we'll pull real pieces from shops near you to fill it in.
            </p>
            <ul className="steps">
              <li><span className="num">01</span> Drop a photo of the space</li>
              <li><span className="num">02</span> Tell us the budget and style</li>
              <li><span className="num">03</span> Mark where it goes and preview</li>
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
        <section className="section">
          <p className="section__eyebrow"><span className="num">1</span> Drop a photo</p>
          <h2>Show us the space</h2>

          {!upload && <UploadForm onUploaded={setUpload} />}

          {upload && (
            <div className="uploaded-preview">
              <img src={upload.image_url} alt="Your uploaded space" />
              <IntakeForm onSubmit={handleIntakeSubmit} submitting={suggestState.status === 'loading'} />
            </div>
          )}
        </section>

        {suggestState.status === 'error' && (
          <section className="section">
            <p role="alert">Couldn't load suggestions right now. Please try again.</p>
          </section>
        )}

        {suggestState.status === 'idle' && (suggestState.suggestions.length > 0 || suggestState.message) && (
          <section className="section">
            <p className="section__eyebrow"><span className="num">2</span> Local picks</p>
            <h2>What we found nearby</h2>
            <SuggestionList
              suggestions={suggestState.suggestions}
              message={suggestState.message}
              onSelect={handleSelectSuggestion}
              selectingProductId={pendingProductId}
            />
          </section>
        )}

        {pendingProductId && (
          <section className="section">
            <p className="section__eyebrow"><span className="num">3</span> Mark the spot</p>
            <h2>Where should it go?</h2>
            <MaskCanvas imageUrl={upload.image_url} onMaskReady={handleMaskReady} />
          </section>
        )}

        {compositeState.status && (
          <section className="section">
            <p className="section__eyebrow"><span className="num">4</span> Preview</p>
            <h2>Your space, filled in</h2>
            <CompositePreview
              status={compositeState.status}
              compositeUrl={compositeState.url}
              error={compositeState.error}
            />
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="site-footer__inner">
          fillstock — phase 2 · real compositing · local shops soon
        </div>
      </footer>
    </div>
  );
}
