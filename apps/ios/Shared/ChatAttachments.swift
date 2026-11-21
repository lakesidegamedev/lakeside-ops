import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import LakesideCore

private func attachmentPhoto(_ data: Data) throws -> Data {
    guard data.count <= 20 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048
          ] as CFDictionary), let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.85) else {
        throw AppFailure(message: "This photo could not be loaded. Choose an image smaller than 20 MB.")
    }
    return jpeg
}

@MainActor
final class ChatAttachments: ObservableObject {
    struct Item: Identifiable {
        let id = UUID()
        let name: String
        let size: Int
        let image: UIImage?
        let value: JSONValue
    }
    let keir: Bool
    init(keir: Bool = false) { self.keir = keir }
    /// Whether a Keir chat is answered by the private supervisor; its files go there.
    var supervisorServes: @MainActor (String) -> Bool = { _ in false }
    @Published private var drafts: [String: [Item]] = [:]
    @Published var scope = "main"
    var items: [Item] {
        get { drafts[scope] ?? [] }
        set { drafts[scope] = newValue }
    }
    func sent(_ values: JSONValue, in thread: String) {
        let sent = values.array
        drafts[thread]?.removeAll { item in sent.contains(item.value) }
    }
    @Published var uploading = false
    @Published var error: String?
    var payload: JSONValue { .array(items.map(\.value)) }
    var totalBytes: Int { items.reduce(0) { $0 + $1.size } }
    func add(_ data: Data, name: String, mime: String, session: AppSession, in requestedScope: String? = nil) async {
        let selected = requestedScope ?? scope, existing = drafts[requestedScope ?? scope] ?? []
        guard !uploading else { return }
        guard existing.count < 6, !data.isEmpty, data.count <= 10 * 1024 * 1024,
              existing.reduce(0) { $0 + $1.size } + data.count <= 20 * 1024 * 1024 else {
            error = "Choose up to 6 attachments, at most 10 MB each and 20 MB total."; return
        }
        uploading = true; error = nil; defer { uploading = false }
        do {
            let result = try await session.upload(data, name: name, mime: mime, keirThread: keir ? selected : nil, supervisor: keir && supervisorServes(selected))
            drafts[selected, default: []].append(Item(name: result["name"].string.nonempty ?? name, size: data.count,
                              image: mime.hasPrefix("image/") ? UIImage(data: data) : nil, value: result))
        } catch { self.error = error.localizedDescription }
    }
    func remove(_ item: Item, session: AppSession) async {
        guard !uploading else { return }
        let selected = scope
        uploading = true; defer { uploading = false }
        do { try await session.discardUpload(item.value["url"], keir: keir); drafts[selected]?.removeAll { $0.id == item.id }; error = nil }
        catch { self.error = error.localizedDescription }
    }
    func addFile(_ url: URL, session: AppSession, in requestedScope: String? = nil) async {
        let selected = requestedScope ?? scope
        do {
            let data = try await Task.detached {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 10 * 1024 * 1024 else { throw AppFailure(message: "Files must be 10 MB or smaller.") }
                let data = try Data(contentsOf: url)
                guard data.count <= 10 * 1024 * 1024 else { throw AppFailure(message: "Files must be 10 MB or smaller.") }
                return data
            }.value
            let type = UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true {
                let jpeg = try await Task.detached { try attachmentPhoto(data) }.value
                await add(jpeg, name: url.deletingPathExtension().lastPathComponent + ".jpg", mime: "image/jpeg", session: session, in: selected)
            } else { await add(data, name: url.lastPathComponent, mime: type?.preferredMIMEType ?? "text/plain", session: session, in: selected) }
        } catch { self.error = error.localizedDescription }
    }
}

struct AttachmentPicker: View {
    @ObservedObject var attachments: ChatAttachments
    var compact = false
    @State private var files = false
    @State private var choices = false
    @State private var photos = false
    var body: some View {
        Button { choices = true } label: {
            Label("Attach", systemImage: "paperclip").font(.subheadline.weight(.semibold))
                .labelStyle(AttachmentLabelStyle(compact: compact)).frame(minHeight: 44)
        }
            .accessibilityLabel("Add attachment").accessibilityIdentifier("add-attachment")
            .disabled(attachments.uploading || attachments.items.count >= 6)
            .confirmationDialog("Add to your message", isPresented: $choices, titleVisibility: .visible) {
                Button("Photo library") { photos = true }
                Button("Choose file") { files = true }
                Button("Cancel", role: .cancel) {}
            }
            .attachmentSources(attachments, photos: $photos, files: $files)
    }
}

extension View {
    /// The photo library and file importer behind any attach control. Keir's
    /// composer opens them from its own menu; other screens use AttachmentPicker.
    func attachmentSources(_ attachments: ChatAttachments, photos: Binding<Bool>, files: Binding<Bool>) -> some View {
        modifier(AttachmentSources(attachments: attachments, photos: photos, files: files))
    }
}

private struct AttachmentSources: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var attachments: ChatAttachments
    @Binding var photos: Bool
    @Binding var files: Bool
    @State private var photo: PhotosPickerItem?
    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $photos, selection: $photo, matching: .images)
            .fileImporter(isPresented: $files, allowedContentTypes: [.image, .pdf, .text, .json, .data], allowsMultipleSelection: true) { result in
                let selected = attachments.scope
                Task {
                    do { for url in try result.get().prefix(6 - attachments.items.count) { await attachments.addFile(url, session: session, in: selected) } }
                    catch { attachments.error = error.localizedDescription }
                }
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                let selected = attachments.scope
                Task {
                    defer { photo = nil }
                    do {
                        guard let data = try await item.loadTransferable(type: Data.self) else { throw AppFailure(message: "This photo could not be loaded.") }
                        let jpeg = try await Task.detached { try attachmentPhoto(data) }.value
                        await attachments.add(jpeg, name: "Photo.jpg", mime: "image/jpeg", session: session, in: selected)
                    } catch { attachments.error = error.localizedDescription }
                }
            }
    }
}

private struct AttachmentLabelStyle: LabelStyle {
    var compact: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack { configuration.icon; if !compact { configuration.title } }
    }
}

struct AttachmentTray: View {
    @EnvironmentObject private var session: AppSession
    @ObservedObject var attachments: ChatAttachments
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !attachments.items.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments.items) { item in
                            HStack(spacing: 6) {
                                if let image = item.image { Image(uiImage: image).resizable().scaledToFill().frame(width: 32, height: 32).clipped().clipShape(RoundedRectangle(cornerRadius: 5)) }
                                else { Image(systemName: "doc") }
                                Text(item.name).font(.caption).lineLimit(1).frame(maxWidth: 130)
                                Button { Task { await attachments.remove(item, session: session) } } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove \(item.name)").disabled(attachments.uploading)
                            }.padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }
            if attachments.uploading { LoadingShimmer(text: "Uploading attachment…").font(.caption) }
            if let error = attachments.error { Text(error).font(.caption).foregroundStyle(.orange) }
        }
    }
}

/// A status line that is in progress. One look everywhere: the shared
/// shimmer from `OpsShimmerText`, matched to the Ask website.
struct LoadingShimmer: View {
    var text: String
    var body: some View {
        OpsShimmerText(text: text).accessibilityLabel(text)
    }
}
