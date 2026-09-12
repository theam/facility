// Next's font loader receives local CSS; browser acceptance never fetches Google Fonts.
module.exports = new Proxy(
  {},
  { get: () => "@font-face { font-family: 'Fixture'; src: local('Arial'); }" },
);
