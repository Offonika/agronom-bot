async function callGptVisionStub(_path) {
  return {
    crop: 'apple',
    disease: 'powdery_mildew',
    confidence: 0.92,
  };
}

module.exports = { callGptVisionStub };
