// Only loaded by the single explicitly authorized visible-desktop fixture session.
exports.install = ({ app, BrowserWindow }) => {
  const showInactive = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.show = function () {
    return showInactive.call(this);
  };
  BrowserWindow.prototype.focus = function () {};
  app.on("web-contents-created", (_event, contents) => {
    contents.focus = () => {};
  });
};
